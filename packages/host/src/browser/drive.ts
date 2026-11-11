import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ActivityEntry, Approvals } from "../approvals/approvals.ts";
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
};

type Gate = "approved" | "denied" | "cancelled";

/** Drives the installed Chrome over the remote debugging port. */
export class BrowserDrive {
  private client: CdpClient | null = null;
  private currentUrl = "";
  private readonly approvedHosts = new Set<string>();
  private shots = 0;

  constructor(private readonly options: DriveOptions) {}

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
    if (!this.canDrive()) {
      this.log(`${this.blockedMessage()} ${summary} did not run.`);
      return { ok: false, allowed: false, url, message: this.blockedMessage() };
    }
    const decision = await this.gate(summary, "browser.navigate", url, signal);
    if (decision !== "approved") {
      return this.refused(decision, url);
    }
    if (this.halted(signal)) {
      return this.stopped(url);
    }
    try {
      const client = await this.ensure(url);
      if (this.halted(signal)) {
        return this.stopped(url);
      }
      await client.send("Page.navigate", { url });
      await this.waitReady(client, signal);
      if (this.halted(signal)) {
        return this.stopped(url);
      }
      this.currentUrl = url;
      this.approvedHosts.add(host);
      this.options.session.note(summary);
      this.log(`Navigated to ${host}`);
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
      return {
        ok: false,
        allowed: true,
        url,
        message: `Chrome did not open ${host}. ${detail}`,
      };
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
      return this.refused(decision);
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
      return this.refused(decision);
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
    if (
      this.client &&
      this.currentUrl &&
      url &&
      samePage(url, this.currentUrl) &&
      this.approvedHosts.has(new URL(this.currentUrl).host)
    ) {
      if (this.halted(signal)) {
        return this.stopped(this.currentUrl);
      }
      const page = (await this.evaluate(readExpression())) as {
        title?: string;
        headings?: string[];
        text?: string;
      };
      const host = new URL(this.currentUrl).host;
      this.options.session.note(`read ${host}`);
      this.log(`Read ${host}`);
      return {
        ok: true,
        allowed: true,
        opened: true,
        url: this.currentUrl,
        title: page.title ?? "",
        headings: page.headings ?? [],
        text: page.text ?? "",
      };
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
      this.options.fetchPage(target, signal),
    );
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
    const shot = (await client.send("Page.captureScreenshot", {
      format: "png",
    })) as { data?: string };
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

  private async ensure(url: string): Promise<CdpClient> {
    if (!this.client) {
      this.client = await this.options.connect(url);
      await this.client.send("Page.enable");
      await this.client.send("Runtime.enable");
    }
    return this.client;
  }

  private async evaluate(expression: string): Promise<unknown> {
    const client = await this.ensure(this.currentUrl || "about:blank");
    const payload = (await client.send("Runtime.evaluate", {
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

  private async waitReady(
    client: CdpClient,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.halted(signal)) {
        return;
      }
      const state = await this.evaluate("document.readyState");
      if (state === "complete" || state === "interactive") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    void client;
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
    return "Chrome is not installed. Install Google Chrome, then try again. Reading a page still works without it.";
  }

  private halted(signal?: AbortSignal): boolean {
    return signal?.aborted === true || this.options.session.stopped;
  }

  private refused(decision: Gate, url?: string): DriveResult {
    if (decision === "cancelled") {
      return this.stopped(url);
    }
    return {
      ok: false,
      allowed: false,
      url,
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
    if (!this.currentUrl) {
      return "";
    }
    return new URL(this.currentUrl).host;
  }

  private log(summary: string): void {
    this.options.audit({
      at: new Date(this.now()).toISOString(),
      summary,
      decision: "browser",
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export function chromeLaunchArgs(
  userDataDir: string,
  port: number,
  url: string,
): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    url,
  ];
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
  url: string,
): Promise<CdpClient> {
  const port = await freePort();
  mkdirSync(userDataDir, { recursive: true });
  const child = spawn(executable, chromeLaunchArgs(userDataDir, port, url), {
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

async function waitForPage(port: number): Promise<string> {
  const deadline = Date.now() + 8_000;
  let last = "Chrome did not open a debugging page.";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(last);
}

function openSocket(url: string, onClose: () => void): Promise<CdpClient> {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
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
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async close() {
          ws.close();
          onClose();
        },
      });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Chrome debugging socket failed."));
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
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
