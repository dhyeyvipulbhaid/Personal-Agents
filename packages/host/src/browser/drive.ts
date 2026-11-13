import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ActivityEntry, Approvals } from "../approvals/approvals.ts";
import { MAX_THUMB_CHARS, thumbParams } from "./preview.ts";
import { READABLE_CHAR_LIMIT } from "./read.ts";
import type { BrowserSession } from "./session.ts";

export type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

export type DriveResult = {
  ok: boolean;
  allowed: boolean;
  cancelled?: boolean;
  denied?: boolean;
  action?: "navigate" | "click" | "type";
  target?: string;
  url?: string;
  opened?: boolean;
  title?: string;
  headings?: string[];
  text?: string;
  message?: string;
  path?: string;
};

type DriveOptions = {
  approvals: Approvals;
  session: BrowserSession;
  audit: (entry: ActivityEntry) => void;
  executable: string | null;
  debuggingBlocked?: boolean;
  dataDir: string;
  connect: (url: string) => Promise<CdpClient>;
  fetchPage: (url: string, signal?: AbortSignal) => Promise<string>;
  now?: () => number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timers?: DeadlineTimers;
  platform?: NodeJS.Platform;
  activate?: (command: readonly string[]) => Promise<void>;
};

export type DeadlineTimers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

type Gate = "approved" | "denied" | "cancelled";

/** One Chrome command. A heavy page must not stall the host past this. */
export const CDP_COMMAND_MS = 3_000;
const READY_BUDGET_MS = 1_500;
const MAX_CDP_CHARS = 400_000;

const realTimers: DeadlineTimers = {
  set(fn, ms) {
    return setTimeout(fn, ms);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function commandDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  timers: DeadlineTimers = realTimers,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = timers.set(() => {
      reject(new Error(`Chrome did not answer ${label}.`));
    }, ms);
    work.then(
      (value) => {
        timers.clear(timer);
        resolve(value);
      },
      (error: unknown) => {
        timers.clear(timer);
        reject(error);
      },
    );
  });
}

function isCdpTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Chrome did not answer") ||
      error.message.includes("too large"))
  );
}

function isStaleConnection(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.startsWith("Chrome did not answer") ||
    error.message.includes("debugging socket")
  );
}

function aborted(): Error {
  const error = new Error("Stopped.");
  error.name = "AbortError";
  return error;
}

/** Drives the installed Chrome over the remote debugging port. */
export class BrowserDrive {
  private client: CdpClient | null = null;
  private currentUrl = "";
  private step = "";
  private lastAction = 0;
  private readonly recent: { at: string; summary: string }[] = [];
  private readonly approvedHosts = new Set<string>();
  private shots = 0;
  private backgroundUrl = "";
  private abortRead: (() => void) | undefined;
  private working = false;

  constructor(private readonly options: DriveOptions) {}

  hasSession(): boolean {
    return (
      (this.client !== null && this.currentUrl.length > 0) ||
      this.backgroundUrl.length > 0
    );
  }

  pageUrl(): string {
    return this.backgroundUrl || this.currentUrl;
  }

  site(): string {
    return this.hostLabel();
  }

  currentStep(): string {
    return this.step;
  }

  busy(): boolean {
    return this.working;
  }

  wantsThumb(): boolean {
    return this.backgroundUrl.length === 0 && this.client !== null;
  }

  lastActionAt(): number {
    return this.lastAction;
  }

  recentActions(): { at: string; summary: string }[] {
    return this.recent.slice(0, 5);
  }

  async captureThumb(): Promise<string> {
    if (!this.client || this.backgroundUrl.length > 0) {
      return "";
    }
    try {
      const shot = (await this.command(
        this.client,
        "Page.captureScreenshot",
        thumbParams(),
      )) as { data?: string };
      const data = typeof shot.data === "string" ? shot.data : "";
      return data.length <= MAX_THUMB_CHARS ? data : "";
    } catch {
      return "";
    }
  }

  async halt(): Promise<void> {
    this.abortRead?.();
    this.abortRead = undefined;
    this.working = false;
    this.backgroundUrl = "";
    this.currentUrl = "";
    this.step = "";
    await this.close();
    this.log("Stopped the browser");
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await client.close();
    }
  }

  async navigate(raw: string, signal?: AbortSignal): Promise<DriveResult> {
    const url = canonical(raw);
    if (!url) {
      return {
        ok: false,
        allowed: false,
        message: "That URL is not valid.",
      };
    }
    const host = new URL(url).host;
    const summary = `navigate to ${host}`;
    this.noteStep(summary);
    if (!this.canDrive()) {
      this.log(`${this.blockedMessage()} ${summary} did not run.`);
      return { ok: false, allowed: false, url, message: this.blockedMessage() };
    }
    const decision = await this.gate(summary, "browser.navigate", url, signal);
    if (decision !== "approved") {
      return this.refused(decision, "navigate", url, undefined, summary);
    }
    if (this.halted(signal)) {
      return this.stopped(url);
    }
    this.working = true;
    try {
      const opened = await this.openWindow(url, signal);
      if (this.halted(signal)) {
        return this.stopped(url);
      }
      if (!opened) {
        await this.dropClient();
        this.currentUrl = "";
        this.noteStep("");
        return {
          ok: false,
          allowed: true,
          url,
          message: `Could not confirm that ${host} opened in Chrome.`,
        };
      }
      this.currentUrl = url;
      this.approvedHosts.add(host);
      this.options.session.note(summary);
      this.log(`Navigated to ${host}`);
      this.noteStep(`done navigate ${host}`);
      return {
        ok: true,
        allowed: true,
        url,
        message: `Opened ${host} in Chrome.`,
      };
    } catch (error) {
      if (this.halted(signal) || isAbort(error)) {
        return this.stopped(url);
      }
      const detail = error instanceof Error ? error.message : "Chrome failed.";
      if (isStaleConnection(error)) {
        await this.dropClient();
      }
      if (!this.client) {
        this.currentUrl = "";
      }
      if (isStaleConnection(error)) {
        return {
          ok: false,
          allowed: true,
          url,
          message: `Chrome did not open a window, so ${host} was not opened. ${detail}`,
        };
      }
      return {
        ok: false,
        allowed: true,
        url,
        message: `Chrome did not start, so ${host} was not opened in Safari or any other browser. ${detail}`,
      };
    } finally {
      this.working = false;
    }
  }

  async click(target: string, signal?: AbortSignal): Promise<DriveResult> {
    const label = shown(target);
    if (label.length === 0) {
      return {
        ok: false,
        allowed: false,
        message: "browser.click needs a selector or visible text.",
      };
    }
    const where = this.hostLabel();
    const summary = where ? `click "${label}" on ${where}` : `click "${label}"`;
    this.noteStep(summary);
    if (!this.canDrive()) {
      this.log(`${this.blockedMessage()} ${summary} did not run.`);
      return { ok: false, allowed: false, message: this.blockedMessage() };
    }
    if (!this.currentUrl) {
      this.log(`${summary} did not run because no page is open.`);
      return {
        ok: false,
        allowed: false,
        message: "No page is open. Navigate first.",
      };
    }
    const decision = await this.gate(summary, "browser.click", label, signal);
    if (decision !== "approved") {
      return this.refused(decision, "click", this.currentUrl, label, summary);
    }
    if (this.halted(signal)) {
      return this.stopped();
    }
    const value = (await this.evaluate(clickExpression(target))) as {
      ok?: boolean;
    };
    if (!value?.ok) {
      this.log(`Click failed: "${label}" was not on ${where}.`);
      return {
        ok: false,
        allowed: true,
        message: `Could not find "${label}" on ${where}.`,
      };
    }
    this.options.session.note(summary);
    this.log(`Clicked "${label}" on ${where}`);
    return {
      ok: true,
      allowed: true,
      message: `Clicked "${label}" on ${where}.`,
    };
  }

  async type(
    selector: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<DriveResult> {
    const field = shown(selector);
    const typed = shown(text);
    if (field.length === 0 || text.length === 0) {
      return {
        ok: false,
        allowed: false,
        message: "browser.type needs a selector and text.",
      };
    }
    const where = this.hostLabel();
    const summary = where
      ? `type "${typed}" into "${field}" on ${where}`
      : `type "${typed}" into "${field}"`;
    this.noteStep(summary);
    if (!this.canDrive()) {
      this.log(`${this.blockedMessage()} ${summary} did not run.`);
      return { ok: false, allowed: false, message: this.blockedMessage() };
    }
    if (!this.currentUrl) {
      this.log(`${summary} did not run because no page is open.`);
      return {
        ok: false,
        allowed: false,
        message: "No page is open. Navigate first.",
      };
    }
    const decision = await this.gate(summary, "browser.type", text, signal);
    if (decision !== "approved") {
      return this.refused(decision, "type", this.currentUrl, field, summary);
    }
    if (this.halted(signal)) {
      return this.stopped();
    }
    const value = (await this.evaluate(typeExpression(selector, text))) as {
      ok?: boolean;
    };
    if (!value?.ok) {
      this.log(`Type failed: "${field}" was not on ${where}.`);
      return {
        ok: false,
        allowed: true,
        message: `Could not find "${field}" on ${where}.`,
      };
    }
    this.options.session.note(summary);
    this.log(`Typed into "${field}" on ${where}`);
    return {
      ok: true,
      allowed: true,
      message: `Typed into "${field}" on ${where}.`,
    };
  }

  async read(raw?: string, signal?: AbortSignal): Promise<DriveResult> {
    const url = raw ? canonical(raw) : this.currentUrl;
    const background = !this.readsOpenPage(url);
    if (background && url) {
      this.armBackground(url);
    }
    if (
      this.client &&
      this.currentUrl &&
      url &&
      samePage(url, this.currentUrl) &&
      this.approvedHosts.has(new URL(this.currentUrl).host)
    ) {
      this.working = true;
      const host = new URL(this.currentUrl).host;
      this.noteStep(`read ${host}`);
      let finished = false;
      try {
        if (this.halted(signal)) {
          return this.stopped(this.currentUrl);
        }
        const page = (await this.evaluate(readExpression())) as {
          title?: string;
          headings?: string[];
          text?: string;
        };
        this.options.session.note(`read ${host}`);
        this.log(`Read ${host}`);
        this.noteStep(`done read ${host}`);
        finished = true;
        return {
          ok: true,
          allowed: true,
          opened: true,
          url: this.currentUrl,
          title: page.title ?? "",
          headings: page.headings ?? [],
          text: page.text ?? "",
        };
      } finally {
        this.working = false;
        if (!finished) {
          this.noteStep(`done navigate ${host}`);
        }
      }
    }
    if (!url) {
      return {
        ok: false,
        allowed: false,
        opened: false,
        message: "No page is open. Pass a url to read it.",
      };
    }
    const loaded = await this.options.session.read(url, (target) =>
      this.options.fetchPage(target, this.liveSignal(signal)),
    );
    if (loaded.cancelled || !loaded.opened) {
      this.clearBackground();
    }
    if (loaded.cancelled) {
      return {
        ok: false,
        allowed: false,
        cancelled: true,
        opened: false,
        url,
        title: "",
        headings: [],
        text: "",
        message: "Stopped.",
      };
    }
    if (!loaded.opened) {
      return {
        ok: false,
        allowed: false,
        opened: false,
        url,
        title: "",
        headings: [],
        text: "",
        message: "That visit was not allowed.",
      };
    }
    this.log(`Read ${new URL(url).host}`);
    this.finishBackground(url);
    return { ok: true, allowed: true, ...loaded };
  }

  async screenshot(signal?: AbortSignal): Promise<DriveResult> {
    const where = this.hostLabel();
    if (!this.canDrive()) {
      this.log(`${this.blockedMessage()} A screenshot did not run.`);
      return { ok: false, allowed: false, message: this.blockedMessage() };
    }
    if (!this.currentUrl || !where || !this.approvedHosts.has(where)) {
      return {
        ok: false,
        allowed: false,
        message: "No approved page is open.",
      };
    }
    if (this.halted(signal)) {
      return this.stopped(this.currentUrl);
    }
    const client = await this.ensure(this.currentUrl);
    let shot: { data?: string };
    try {
      shot = (await this.command(client, "Page.captureScreenshot", {
        format: "png",
      })) as { data?: string };
    } catch (error) {
      if (!isCdpTimeout(error)) {
        throw error;
      }
      return {
        ok: false,
        allowed: true,
        url: this.currentUrl,
        message: "Chrome did not return the image.",
      };
    }
    const bytes = Buffer.from(shot.data ?? "", "base64");
    this.shots += 1;
    const dir = join(this.options.dataDir, "browser-shots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.now()}-${this.shots}.png`);
    writeFileSync(path, bytes);
    this.options.session.note(`screenshot ${where}`);
    this.log(`Saved a screenshot of ${where}`);
    return { ok: true, allowed: true, path, url: this.currentUrl };
  }

  private async gate(
    summary: string,
    capability: string,
    draft: string,
    signal?: AbortSignal,
  ): Promise<Gate> {
    if (this.halted(signal)) {
      return "cancelled";
    }
    const decision = await new Promise<{ decision: string }>((resolve) => {
      void this.options.approvals.runTask("browser", async (task) => {
        resolve(
          await task.request({
            summary,
            draft,
            capability,
          }),
        );
      });
    });
    if (decision.decision === "cancelled" || this.halted(signal)) {
      return "cancelled";
    }
    return decision.decision === "approved" ? "approved" : "denied";
  }

  private command(
    client: CdpClient,
    method: string,
    params?: Record<string, unknown>,
    ms = CDP_COMMAND_MS,
  ): Promise<unknown> {
    return commandDeadline(
      client.send(method, params),
      ms,
      method,
      this.options.timers,
    );
  }

  private async ensure(url: string): Promise<CdpClient> {
    if (!this.client) {
      this.client = await this.options.connect(url);
      try {
        await this.command(this.client, "Page.enable");
        await this.command(this.client, "Runtime.enable");
      } catch (error) {
        await this.dropClient();
        throw error;
      }
    }
    return this.client;
  }

  private async openWindow(
    url: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const first = await this.attemptOpen(url, signal);
    if (first === "stopped") {
      throw aborted();
    }
    if (first === "open") {
      return true;
    }
    await this.dropClient();
    if (this.halted(signal)) {
      throw aborted();
    }
    await this.revealInChrome(url);
    const second = await this.attemptOpen(url, signal);
    if (second === "stopped") {
      throw aborted();
    }
    return second === "open";
  }

  private async attemptOpen(
    url: string,
    signal?: AbortSignal,
  ): Promise<"open" | "miss" | "stopped"> {
    if (this.halted(signal)) {
      return "stopped";
    }
    try {
      const client = await this.ensure(url);
      if (this.halted(signal)) {
        return "stopped";
      }
      await this.command(client, "Page.navigate", { url });
      if (this.halted(signal)) {
        return "stopped";
      }
      await this.focusChrome(client);
      const href = await this.visibleHref(client, url, signal);
      if (this.halted(signal)) {
        return "stopped";
      }
      return href ? "open" : "miss";
    } catch (error) {
      if (this.halted(signal) || isAbort(error)) {
        return "stopped";
      }
      if (isRecoverable(error)) {
        return "miss";
      }
      throw error;
    }
  }

  private async visibleHref(
    client: CdpClient,
    url: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const deadline = this.clock() + READY_BUDGET_MS;
    while (this.clock() < deadline) {
      if (this.halted(signal)) {
        return null;
      }
      const href = await this.shownHref(client, url);
      if (href) {
        return href;
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0) {
        break;
      }
      await this.sleep(Math.min(50, remaining));
    }
    return null;
  }

  private async shownHref(
    client: CdpClient,
    url: string,
  ): Promise<string | null> {
    const info = await this.attachedTarget(client);
    if (info && (info.type !== "page" || info.attached === false)) {
      return null;
    }
    const proof = await this.pageProof(client);
    if (
      !proof?.href ||
      proof.state !== "visible" ||
      !hostMatches(proof.href, url)
    ) {
      return null;
    }
    if (info?.url && info.url.length > 0 && !hostMatches(info.url, url)) {
      return null;
    }
    return proof.href;
  }

  private async attachedTarget(client: CdpClient): Promise<{
    type?: string;
    url?: string;
    attached?: boolean;
  } | null> {
    try {
      const info = (await this.command(
        client,
        "Target.getTargetInfo",
        undefined,
        500,
      )) as {
        targetInfo?: { type?: string; url?: string; attached?: boolean };
      };
      return info.targetInfo ?? null;
    } catch (error) {
      if (isStaleConnection(error)) {
        throw error;
      }
      return null;
    }
  }

  private async pageProof(client: CdpClient): Promise<{
    href: string;
    state: string;
  } | null> {
    try {
      const payload = (await this.command(
        client,
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({href:location.href,state:document.visibilityState})",
          returnByValue: true,
        },
        READY_BUDGET_MS,
      )) as { result?: { value?: unknown } };
      const raw = payload.result?.value;
      if (typeof raw !== "string") {
        return null;
      }
      const parsed = JSON.parse(raw) as { href?: unknown; state?: unknown };
      if (typeof parsed.href !== "string") {
        return null;
      }
      return {
        href: parsed.href,
        state: typeof parsed.state === "string" ? parsed.state : "",
      };
    } catch (error) {
      if (isAbort(error) || isStaleConnection(error)) {
        throw error;
      }
      return null;
    }
  }

  private async revealInChrome(url: string): Promise<void> {
    const command = chromeRevealCommand(
      this.options.platform ?? process.platform,
      url,
    );
    if (!command) {
      return;
    }
    try {
      const run = this.options.activate ?? runChromeFront;
      await run(command);
    } catch {
      // The relaunch still has to prove which tab is visible.
    }
  }

  private async focusChrome(client: CdpClient): Promise<void> {
    const command = chromeFrontCommand(
      this.options.platform ?? process.platform,
    );
    if (command) {
      try {
        const run = this.options.activate ?? runChromeFront;
        await run(command);
      } catch {
        // The page was already asked to load.
      }
    }
    try {
      await this.command(client, "Page.bringToFront");
    } catch {
      // The page was already asked to load.
    }
  }

  private async dropClient(): Promise<void> {
    try {
      await this.close();
    } catch {
      this.client = null;
    }
  }

  private async evaluate(expression: string): Promise<unknown> {
    const client = await this.ensure(this.currentUrl || "about:blank");
    const payload = (await this.command(client, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    };
    if (payload.exceptionDetails) {
      throw new Error(
        payload.exceptionDetails.text ?? "The page script failed.",
      );
    }
    return payload.result?.value;
  }

  private canDrive(): boolean {
    return (
      this.options.executable !== null &&
      this.options.executable.length > 0 &&
      this.options.debuggingBlocked !== true
    );
  }

  private blockedMessage(): string {
    if (this.options.debuggingBlocked) {
      return "Remote debugging is turned off by policy (RemoteDebuggingAllowed), so Chrome was not started.";
    }
    return "Chrome is not installed, so nothing was opened in Safari or another browser. Install Google Chrome, then try again. Reading a page still works without it.";
  }

  private halted(signal?: AbortSignal): boolean {
    return signal?.aborted === true || this.options.session.stopped;
  }

  private refused(
    decision: Gate,
    action: "navigate" | "click" | "type",
    url?: string,
    target?: string,
    summary?: string,
  ): DriveResult {
    if (decision === "cancelled") {
      return this.stopped(url);
    }
    if (summary) {
      this.log(`Denied: ${summary}`);
    }
    return {
      ok: false,
      allowed: false,
      denied: true,
      action,
      url,
      target,
      message: "That action was not allowed.",
    };
  }

  private stopped(url?: string): DriveResult {
    return {
      ok: false,
      allowed: false,
      cancelled: true,
      url,
      message: "Stopped.",
    };
  }

  private hostLabel(): string {
    const url = this.pageUrl();
    if (!url) {
      return "";
    }
    return new URL(url).host;
  }

  private readsOpenPage(url: string | null): boolean {
    return (
      this.client !== null &&
      this.currentUrl.length > 0 &&
      url !== null &&
      samePage(url, this.currentUrl) &&
      this.approvedHosts.has(new URL(this.currentUrl).host)
    );
  }

  private armBackground(url: string): void {
    this.backgroundUrl = url;
    this.working = true;
    this.noteStep(`read ${new URL(url).host}`);
    this.lastAction = this.now();
  }

  private finishBackground(url: string): void {
    this.backgroundUrl = url;
    this.working = false;
    this.noteStep(`done read ${new URL(url).host}`);
    this.lastAction = this.now();
  }

  private clearBackground(): void {
    this.backgroundUrl = "";
    this.working = false;
    if (this.currentUrl.length === 0) {
      this.step = "";
      return;
    }
    this.noteStep(`done navigate ${new URL(this.currentUrl).host}`);
  }

  private liveSignal(parent?: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.abortRead = abort;
    if (parent?.aborted) {
      abort();
    } else {
      parent?.addEventListener("abort", abort, { once: true });
    }
    return controller.signal;
  }

  private noteStep(summary: string): void {
    this.step = summary;
  }

  private log(summary: string): void {
    const at = new Date(this.now()).toISOString();
    this.lastAction = this.now();
    this.recent.unshift({ at, summary });
    if (this.recent.length > 5) {
      this.recent.length = 5;
    }
    this.options.audit({
      at,
      summary,
      decision: "browser",
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private clock(): number {
    return this.options.clock ? this.options.clock() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) {
      return this.options.sleep(ms);
    }
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/** macOS needs an explicit activate; other platforms already raise the window. */
export function chromeFrontCommand(
  platform: NodeJS.Platform,
): readonly string[] | null {
  if (platform !== "darwin") {
    return null;
  }
  return ["osascript", "-e", 'tell application "Google Chrome" to activate'];
}

function chromeRevealCommand(
  platform: NodeJS.Platform,
  url: string,
): readonly string[] | null {
  if (platform !== "darwin") {
    return null;
  }
  return ["open", "-a", "Google Chrome", url];
}

function isRecoverable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    isStaleConnection(error) ||
    isCdpTimeout(error) ||
    error.message.includes("debugging") ||
    error.message.includes("did not open")
  );
}

function hostMatches(actualHref: string, requestedUrl: string): boolean {
  let actual = "";
  let requested = "";
  try {
    actual = new URL(actualHref).host;
    requested = new URL(requestedUrl).host;
  } catch {
    return false;
  }
  if (actual.length === 0 || requested.length === 0) {
    return false;
  }
  return (
    actual === requested ||
    actual === `www.${requested}` ||
    requested === `www.${actual}`
  );
}

function runChromeFront(command: readonly string[]): Promise<void> {
  const [bin, ...args] = command;
  if (!bin) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 1_000);
    child.once("error", (error) => {
      finish(error);
    });
    child.once("close", () => {
      finish();
    });
  });
}

export function chromeLaunchArgs(userDataDir: string, port: number): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];
}

function assertChromeBinary(executable: string): void {
  const base = executable.split(/[\\/]/).pop() ?? "";
  if (
    /^(open|xdg-open|start|explorer)$/i.test(base) ||
    /NSWorkspace|ShellExecute|window\.open/i.test(executable)
  ) {
    throw new Error(
      "Refusing to open a page with the default browser. Install Google Chrome.",
    );
  }
}

export function chromeExecutable(input?: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists?: (path: string) => boolean;
}): string | null {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const home = input?.home ?? homedir();
  const exists = input?.exists ?? existsSync;
  for (const candidate of chromeCandidates(platform, env, home)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function connectChrome(
  executable: string,
  userDataDir: string,
): Promise<CdpClient> {
  assertChromeBinary(executable);
  const port = await freePort();
  mkdirSync(userDataDir, { recursive: true });
  const child = spawn(executable, chromeLaunchArgs(userDataDir, port), {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const page = await waitForPage(port);
    return await openSocket(page, () => {
      child.kill();
    });
  } catch (error) {
    child.kill();
    throw error;
  }
}

function chromeCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const join = platform === "win32" ? win32.join : posix.join;
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles =
      env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 =
      env["ProgramFiles(x86)"] ??
      env["PROGRAMFILES(X86)"] ??
      "C:\\Program Files (x86)";
    return [
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  ];
}

function canonical(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const text = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(text).toString();
  } catch {
    return null;
  }
}

function samePage(left: string, right: string): boolean {
  const a = new URL(left);
  const b = new URL(right);
  return (
    a.origin === b.origin && a.pathname === b.pathname && a.search === b.search
  );
}

function shown(value: string): string {
  return value.replaceAll(/\s+/g, " ").replaceAll('"', "'").trim().slice(0, 80);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function clickExpression(target: string): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const labelOf = (node) => String(node.innerText || (node.getAttribute && node.getAttribute("aria-label")) || node.value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    let el = null;
    try { el = document.querySelector(target); } catch (error) { el = null; }
    if (!el) {
      const nodes = Array.from(document.querySelectorAll("a, button, input, textarea, label, summary"));
      const want = target.trim().toLowerCase();
      el = nodes.find((node) => labelOf(node) === want) || nodes.find((node) => labelOf(node).includes(want)) || null;
    }
    if (!el || typeof el.click !== "function") return { ok: false };
    el.click();
    return { ok: true };
  })()`;
}

function typeExpression(selector: string, text: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    let el = null;
    try { el = document.querySelector(selector); } catch (error) { el = null; }
    if (!el || !("value" in el)) return { ok: false };
    if (typeof el.focus === "function") el.focus();
    el.value = text;
    if (typeof el.dispatchEvent === "function") {
      el.dispatchEvent({ type: "input" });
      el.dispatchEvent({ type: "change" });
    }
    return { ok: true };
  })()`;
}

function readExpression(): string {
  return `(() => {
    const title = String(document.title || "");
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((node) => String(node.innerText || "").replace(/\\s+/g, " ").trim()).filter((item) => item.length > 0).slice(0, 12);
    const root = document.querySelector("main") || document.querySelector("article") || document.body;
    const text = String((root && root.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, ${READABLE_CHAR_LIMIT});
    return { title, headings, text };
  })()`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function waitForPage(
  port: number,
  deadlineMs = 8_000,
): Promise<string> {
  const deadlineAt = Date.now() + deadlineMs;
  let last = "Chrome did not open a debugging page.";
  while (Date.now() < deadlineAt) {
    try {
      const remaining = Math.max(1, deadlineAt - Date.now());
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.min(1_000, remaining)),
      });
      const list = (await response.json()) as {
        type?: string;
        webSocketDebuggerUrl?: string;
      }[];
      const page = list.find(
        (item) => item.type === "page" && item.webSocketDebuggerUrl,
      );
      if (page?.webSocketDebuggerUrl) {
        return page.webSocketDebuggerUrl;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
    if (Date.now() >= deadlineAt) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(last);
}

export function openSocket(
  url: string,
  onClose: () => void,
  commandMs = CDP_COMMAND_MS,
): Promise<CdpClient> {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const failPending = (message: string) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(message));
    }
    pending.clear();
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Chrome debugging socket did not open."));
    }, 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send(method, params) {
          const id = next + 1;
          next = id;
          return new Promise((res, rej) => {
            const commandTimer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`Chrome did not answer ${method}.`));
            }, commandMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(commandTimer);
                res(value);
              },
              reject: (error) => {
                clearTimeout(commandTimer);
                rej(error);
              },
            });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              clearTimeout(commandTimer);
              pending.delete(id);
              rej(
                error instanceof Error
                  ? error
                  : new Error("Chrome debugging socket failed."),
              );
            }
          });
        },
        async close() {
          failPending("Chrome debugging socket closed.");
          ws.close();
          onClose();
        },
      });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Chrome debugging socket failed."));
    });
    ws.addEventListener("close", () => {
      failPending("Chrome debugging socket closed.");
    });
    ws.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string" ? event.data : String(event.data);
      if (raw.length > MAX_CDP_CHARS) {
        const idMatch = /^\{"id":(\d+)/.exec(raw.slice(0, 80));
        if (idMatch) {
          const waiter = pending.get(Number(idMatch[1]));
          pending.delete(Number(idMatch[1]));
          waiter?.reject(new Error("Chrome sent a result that was too large."));
        }
        return;
      }
      const message = JSON.parse(raw) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (typeof message.id !== "number") {
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          new Error(message.error.message ?? "Chrome rejected the command."),
        );
        return;
      }
      waiter.resolve(message.result ?? {});
    });
  });
}
