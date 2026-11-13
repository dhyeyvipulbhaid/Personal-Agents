import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Extractor } from "memory-bank";
import { type ActivityEntry, Approvals } from "./approvals/approvals.ts";
import { decide } from "./broker/broker.ts";
import {
  BrowserDrive,
  chromeExecutable,
  connectChrome,
  type DriveResult,
} from "./browser/drive.ts";
import { type BrowserActivity, BrowserPreview } from "./browser/preview.ts";
import { BrowserSession } from "./browser/session.ts";
import {
  previewWidget,
  specFromRequest,
  templateSpec,
  WidgetBuilder,
  type WidgetSpec,
} from "./builder/builder.ts";
import {
  adviceFor,
  machineChecks,
  readRemoteDebuggingPolicy,
} from "./capabilities/live.ts";
import { type DemoPaths, seedDemoData } from "./data/demo.ts";
import { loadRevenueView, type RevenueView } from "./files/snapshot.ts";
import type { RevenueRow } from "./files/table.ts";
import {
  followUps,
  loadMailbox,
  openMailState,
  recentThreads,
  replyRecipients,
  writeReply,
} from "./mail/mail.ts";
import { MAIL_USER } from "./mail/sample.ts";
import {
  CHAT_AGENT_ID,
  ChatMemory,
  type ChatMemoryClient,
} from "./memory/chat-memory.ts";
import type { MemoryFact } from "./memory/memory.ts";
import {
  type ModelAdapter,
  type ModelCapabilities,
  ModelSettings,
  type RoleName,
  type ToolCall,
  type ToolDefinition,
} from "./models/adapter.ts";
import { ChatSession } from "./models/chat.ts";
import { OLLAMA_PLUGIN_SOURCE, OllamaConnector } from "./models/ollama.ts";
import { probeOllama } from "./ollama.ts";
import { HELLO_PLUGIN_SOURCE } from "./plugins/hello.ts";
import { PluginKernel } from "./plugins/kernel.ts";
import type { RpcMethods } from "./rpc.ts";

const ROLES: RoleName[] = ["chat", "agent", "builder"];

type Session = {
  id: string;
  title: string;
  chat: ChatSession;
  streaming: boolean;
};

type PluginCard = {
  id: string;
  name: string;
  health: "healthy" | "unhealthy";
  summary: string;
  permissions: string[];
};

const PERMISSIONS: Omit<PluginCard, "health">[] = [
  {
    id: "hello",
    name: "Hello",
    summary: "Shows a greeting on Home.",
    permissions: [
      "Draws inside a sandboxed frame on this machine.",
      "Cannot read your files, send mail, or use the network.",
    ],
  },
  {
    id: "files",
    name: "Revenue files",
    summary: "Reads the sample revenue table that ships with the app.",
    permissions: [
      "Reads revenue.csv inside the app data folder.",
      "A file outside that folder is denied and listed on Activity.",
    ],
  },
  {
    id: "mail",
    name: "Mail",
    summary: "Reads the demo mailbox copied onto this machine.",
    permissions: [
      "Reads local .eml files. It does not contact a mail server.",
      "Sending a reply waits for your approval.",
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    summary: "Talks to the model runtime on this computer.",
    permissions: [
      "Connects only to 127.0.0.1:11434.",
      "Does not send prompts to a cloud model.",
    ],
  },
  {
    id: "builder",
    name: "Builder",
    summary: "Turns a sentence into a widget spec.",
    permissions: [
      "Installs a widget only after you approve it.",
      "Does not write or run generated plugin code.",
    ],
  },
  {
    id: "memory",
    name: "Memory",
    summary: "Keeps chat facts on this machine.",
    permissions: [
      "Saves facts after a chat reply, and when you save one on the Memory page.",
      "This version does not encrypt memory.",
    ],
  },
  {
    id: "browser",
    name: "Browser",
    summary: "Can read a page, and can drive the installed Chrome.",
    permissions: [
      "The first visit to a site waits on Approvals.",
      "Navigate, click, and type each wait. Deny or Stop cancels that action.",
    ],
  },
];

export type DesktopOptions = {
  dataDir: string;
  adapter?: ModelAdapter;
  probe?: () => Promise<"running" | "stopped">;
  now?: () => number;
  audit?: (entry: ActivityEntry) => void;
  chromePath?: string | null;
  onBrowserActivity?: (event: BrowserActivity) => void;
  browserConnect?: (url: string) => Promise<{
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  }>;
  memory?: ChatMemoryClient;
  /** When omitted, retain uses the agent model at 127.0.0.1:11434. */
  memoryExtractor?: Extractor;
};

/** The packaged host: widgets, chat, sample data, and the pages' RPC methods. */
export class DesktopApp {
  readonly settings = new ModelSettings();
  private readonly kernel = new PluginKernel();
  private readonly memory: ChatMemoryClient;
  private readonly adapter: ModelAdapter;
  private readonly probe: () => Promise<"running" | "stopped">;
  private readonly now: () => number;
  private readonly approvals: Approvals;
  private readonly builder: WidgetBuilder;
  private readonly paths: DemoPaths;
  private readonly sessions: Session[] = [];
  private activeId = "";
  private nextSession = 0;
  private widgetCount = 0;
  private plan: { spec: WidgetSpec; preview: string } | null = null;
  private notice = "";
  private readonly mailTasks = new Map<string, Promise<void>>();
  private readonly openReplies = new Map<string, string>();
  private readonly browser: BrowserSession;
  private readonly drive: BrowserDrive;
  private readonly preview: BrowserPreview;
  private readonly audit: (entry: ActivityEntry) => void;
  private chatTurn = 0;

  constructor(options: DesktopOptions) {
    this.adapter =
      options.adapter ?? new OllamaConnector((url, init) => fetch(url, init));
    this.probe = options.probe ?? (() => probeOllama());
    this.now = options.now ?? Date.now;
    this.audit = options.audit ?? (() => {});
    this.approvals = new Approvals(this.audit);
    this.browser = new BrowserSession(this.approvals);
    const executable =
      options.chromePath === undefined
        ? chromeExecutable()
        : options.chromePath;
    const debuggingBlocked = readRemoteDebuggingPolicy().some(
      (policy) =>
        policy.key === "RemoteDebuggingAllowed" && policy.value === "false",
    );
    this.drive = new BrowserDrive({
      approvals: this.approvals,
      session: this.browser,
      audit: this.audit,
      executable,
      debuggingBlocked,
      dataDir: options.dataDir,
      now: this.now,
      fetchPage: (url, signal) => loadPageHtml(url, signal),
      connect:
        options.browserConnect ??
        ((_url) =>
          connectChrome(
            executable ?? "",
            join(options.dataDir, "chrome-profile"),
          )),
    });
    this.preview = new BrowserPreview(
      {
        sessionOpen: () => this.drive.hasSession(),
        lastActionAt: () => this.drive.lastActionAt(),
        currentStep: () => this.drive.currentStep(),
        pageUrl: () => this.drive.pageUrl(),
        site: () => this.drive.site(),
        pendingApproval: () => this.browserPending(),
        recentActions: () => this.drive.recentActions(),
        capture: () => this.drive.captureThumb(),
      },
      options.onBrowserActivity ?? (() => {}),
      this.now,
    );
    this.builder = new WidgetBuilder(
      this.kernel,
      this.approvals,
      this.settings,
    );
    this.paths = seedDemoData(options.dataDir);
    this.memory =
      options.memory ??
      new ChatMemory({
        dataDir: options.dataDir,
        agentId: CHAT_AGENT_ID,
        extractor: options.memoryExtractor,
        model: () => this.settings.get("agent"),
      });
  }

  async start(): Promise<void> {
    await this.kernel.load(HELLO_PLUGIN_SOURCE);
    await this.kernel.load(OLLAMA_PLUGIN_SOURCE);
  }

  close(): void {
    this.preview.stop();
    this.kernel.close();
    void this.drive.close();
    try {
      this.memory.close();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      console.error(`memory close failed: ${detail}`);
    }
  }

  methods(): RpcMethods {
    return {
      widgets: () => JSON.stringify(this.kernel.tiles()),
      ollama: async () => this.probe(),
      authorize: (params) => {
        const outcome = decide(params);
        return JSON.stringify({
          decision: outcome.decision,
          reason: outcome.reason,
        });
      },
      approvals: () => JSON.stringify(this.approvals.pending()),
      browser_activity: (params) => {
        const record = asRecord(params);
        const visible = record.visible !== false && record.visible !== "false";
        return JSON.stringify(this.preview.watch(visible));
      },
      browser_stop: async () => {
        this.approvals.cancelTask("browser");
        await this.drive.halt();
        this.preview.stop();
        return JSON.stringify(this.preview.snapshot());
      },
      approval_act: (params) => JSON.stringify(act(this.approvals, params)),
      revenue_status: () => JSON.stringify(this.revenue()),
      capabilities: async () => JSON.stringify(await this.capabilityReport()),
      list_models: async () => JSON.stringify(await this.modelList()),
      set_models: async (params) => {
        await this.applyModels(params);
        return "ok";
      },
      chat_state: () => JSON.stringify(this.view(this.ensure())),
      chat_new: () => {
        const session = this.addSession();
        return JSON.stringify(this.view(session));
      },
      chat_open: (params) => {
        const id = stringField(params, "sessionId", "session_id");
        const session = this.sessions.find((item) => item.id === id);
        if (!session) {
          throw new Error("That chat session is not open. Start a new chat.");
        }
        this.activeId = session.id;
        return JSON.stringify(this.view(session));
      },
      chat_send: async (params) => this.sendChat(params),
      chat_stop: () => {
        const session = this.ensure();
        this.chatTurn += 1;
        session.chat.stop();
        this.approvals.cancelTask("browser");
        this.approvals.cancelTask("chat");
        for (const message of session.chat.messages) {
          if (message.role === "approval" && !settled(message.text)) {
            message.text = `${message.text} (cancelled)`;
          }
        }
        session.streaming = false;
        return JSON.stringify(this.view(session));
      },
      chat_approve: (params) => {
        const session = this.ensure();
        const id = stringField(params, "id");
        if (stringField(params, "action") === "deny") {
          session.chat.denyInline(id);
        } else {
          session.chat.approveInline(id);
        }
        return JSON.stringify(this.view(session));
      },
      mail_state: () => JSON.stringify(this.mailbox()),
      mail_draft: async (params) =>
        JSON.stringify(await this.draftReply(params)),
      memory_list: () => JSON.stringify(this.memory.list()),
      memory_remember: async (params) => {
        const text = stringField(params, "text").trim();
        if (text.length === 0) {
          throw new Error("Write a fact before saving it.");
        }
        return JSON.stringify(await this.memory.remember(text));
      },
      memory_delete: (params) => {
        this.memory.delete(stringField(params, "id"));
        return JSON.stringify(this.memory.list());
      },
      builder_plan: (params) => JSON.stringify(this.planWidget(params)),
      builder_install: (params) => JSON.stringify(this.installWidget(params)),
    };
  }

  private revenue(): RevenueView {
    try {
      return loadRevenueView(
        this.paths.revenueFile,
        this.paths.revenueState,
        this.now(),
        this.approvals.pending().length,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unreadable";
      throw new Error(
        `The revenue sample could not be read (${detail}). It is stored at ${this.paths.revenueFile}. Reopen the app so the demo file can be copied again, or put the sample CSV back in that folder.`,
      );
    }
  }

  private rows(): RevenueRow[] {
    return this.revenue().rows;
  }

  private mailbox() {
    try {
      const messages = loadMailbox(this.paths.mailDir);
      const db = openMailState(this.paths.mailDb);
      try {
        return {
          count: messages.length,
          followUps: followUps(messages, db),
          digest: recentThreads(messages),
          messages: messages.map((message) => ({
            id: message.id,
            from: message.from,
            subject: message.subject,
            date: message.date,
            thread: message.thread,
            body: message.body,
          })),
        };
      } finally {
        db.close();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unreadable";
      throw new Error(
        `The demo mailbox could not be read (${detail}). Messages live in ${this.paths.mailDir}. Reopen the app to copy the sample mailbox again.`,
      );
    }
  }

  private async capabilityReport() {
    const running = (await this.probe()) === "running";
    let models: string[] = [];
    if (running) {
      try {
        models = (await this.adapter.listModels())
          .map((model) => model.name)
          .filter((name) => name.length > 0);
      } catch {
        models = [];
      }
    }
    const checks = machineChecks({
      folders: [
        { path: this.paths.root, readable: true },
        { path: this.paths.mailDir, readable: true },
      ].map((folder) => ({
        ...folder,
        readable: canRead(folder.path),
      })),
      ollamaPortOpen: running,
      models,
    }).map((check) => ({ ...check, advice: adviceFor(check) }));
    const loaded = new Map(
      this.kernel.loaded().map((plugin) => [plugin.id, plugin.health]),
    );
    const browsersInstalled = checks.some(
      (check) =>
        check.name.startsWith("browser ") && check.status === "available",
    );
    const plugins: PluginCard[] = PERMISSIONS.map((card) => ({
      ...card,
      health: cardHealth(card.id, {
        loaded: loaded.get(card.id),
        revenue: canRead(this.paths.revenueFile),
        mail: checks.some(
          (check) =>
            check.name.includes(this.paths.mailDir) &&
            check.status === "available",
        ),
        ollama: running,
        browser: browsersInstalled,
      }),
    }));
    return { checks, plugins };
  }

  private async modelList() {
    const running = (await this.probe()) === "running";
    let models: ModelCapabilities[] = [];
    if (!running) {
      this.notice = ollamaDownMessage(this.settings.get("chat"));
    } else {
      try {
        models = await this.adapter.listModels();
        this.notice = "";
      } catch (error) {
        models = [];
        this.notice = this.failText(error, this.settings.get("chat"));
      }
    }
    const missing = ROLES.map((role) => this.settings.get(role)).filter(
      (name) => !models.some((model) => model.name === name),
    );
    if (running && missing.length > 0 && this.notice.length === 0) {
      this.notice = missing
        .map((name) => modelNotInstalledMessage(name))
        .join(" ");
    }
    return {
      running,
      models,
      selected: this.selected(),
      missing,
      notice: this.notice,
    };
  }

  private async applyModels(params: unknown): Promise<void> {
    const record = asRecord(params);
    const running = (await this.probe()) === "running";
    let catalog: ModelCapabilities[] = [];
    if (running) {
      try {
        catalog = await this.adapter.listModels();
      } catch (error) {
        throw new Error(this.failText(error, this.settings.get("chat")));
      }
    }
    for (const role of ROLES) {
      const name = typeof record[role] === "string" ? record[role] : "";
      if (name.length === 0) {
        continue;
      }
      if (!catalog.some((model) => model.name === name)) {
        throw new Error(
          running ? modelNotInstalledMessage(name) : ollamaDownMessage(name),
        );
      }
      try {
        this.settings.set(role, name, catalog);
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error("The model could not be saved.");
      }
    }
  }

  private async sendChat(params: unknown): Promise<string> {
    const text = stringField(params, "text");
    const requested = stringField(params, "sessionId", "session_id");
    const session = requested
      ? (this.sessions.find((item) => item.id === requested) ?? this.ensure())
      : this.ensure();
    this.activeId = session.id;
    if (session.title === "New chat" && text.trim().length > 0) {
      session.title = text.trim().slice(0, 48);
    }
    const recalled = await this.recallFacts(text);
    const kind = localQuestion(text);
    const direct = directBrowse(text);
    const approvalsBefore = session.chat.messages.filter(
      (message) => message.role === "approval",
    ).length;
    const remembered = recalled
      .map((fact) => `${fact.text} (source ${fact.source})`)
      .join("\n");
    const context = [toolPrompt(), remembered]
      .filter((part) => part.length > 0)
      .join("\n");
    const turn = ++this.chatTurn;
    session.streaming = true;
    let completed = false;
    try {
      await session.chat.send(text, context, {
        model: kind ? this.settings.get("agent") : this.settings.get("chat"),
        definitions: LOCAL_TOOLS,
        runTool: (call, signal) => this.runLocalTool(call, signal),
        forced: direct
          ? {
              name: "browser.navigate",
              arguments: JSON.stringify({ url: direct.url }),
            }
          : undefined,
      });
      if (direct?.read) {
        await this.fillPageText(session, direct.url);
      } else if (asksLivePage(text)) {
        const browsed =
          session.chat.messages.filter((message) => message.role === "approval")
            .length > approvalsBefore;
        if (!browsed) {
          this.markGeneralKnowledge(session);
        }
      }
      completed = true;
    } catch (error) {
      const detail = this.failText(error, this.settings.get("chat"));
      const assistant = [...session.chat.messages]
        .reverse()
        .find((item) => item.role === "assistant");
      if (assistant) {
        assistant.text = detail;
      }
      console.error(`chat-send failed: ${detail}`);
    } finally {
      if (this.chatTurn === turn) {
        session.streaming = false;
      }
    }
    if (kind === "revenue") {
      this.groundRevenue(session);
    }
    if (completed) {
      const assistant = [...session.chat.messages]
        .reverse()
        .find((item) => item.role === "assistant");
      this.keepExchange(text, assistant?.text ?? "");
    }
    return JSON.stringify(this.view(session));
  }

  private async recallFacts(query: string): Promise<MemoryFact[]> {
    try {
      return await this.memory.recallFacts(query);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      console.error(`memory recall failed: ${detail}`);
      return [];
    }
  }

  private keepExchange(user: string, assistant: string): void {
    void this.memory.retainExchange(user, assistant).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "unknown";
      console.error(`memory retain failed: ${detail}`);
    });
  }

  private async draftReply(params: unknown) {
    const messages = loadMailbox(this.paths.mailDir);
    const id = stringField(params, "id");
    const message = messages.find((item) => item.id === id);
    if (!message) {
      throw new Error(
        "That message is not in the local mailbox. Refresh Mail and try the draft again.",
      );
    }
    const waiting = this.openReplies.get(id);
    if (
      waiting &&
      this.approvals.pending().some((item) => item.id === waiting)
    ) {
      throw new Error(
        "A reply to this message is already waiting in Approvals.",
      );
    }
    if ((await this.probe()) !== "running") {
      throw new Error(ollamaDownMessage(this.settings.get("agent")));
    }
    let draft = "";
    try {
      const result = await this.adapter.chat(
        {
          model: this.settings.get("agent"),
          messages: [
            {
              role: "user",
              content: `Write a short reply from ${MAIL_USER}. Do not copy the original message.\nFrom: ${message.from}\nSubject: ${message.subject}\n\n${message.body}`,
            },
          ],
        },
        () => {},
      );
      draft = result.text.trim();
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "The agent model did not answer.";
      throw new Error(
        detail.includes("ollama pull") || detail.includes("not running")
          ? detail
          : `The agent model could not draft a reply. ${detail}`,
      );
    }
    if (draft.length === 0 || draft === message.body.trim()) {
      throw new Error(
        "The agent model did not write a reply, so nothing was sent to Approvals.",
      );
    }
    const subject = message.subject.startsWith("Re:")
      ? message.subject
      : `Re: ${message.subject}`;
    const to = replyRecipients(message);
    const task = this.approvals.runTask("mail", async (ctx) => {
      const result = await ctx.request({
        summary: `Reply to ${message.thread}`,
        draft,
        capability: "mail.send",
        effects: ["sends"],
      });
      if (result.decision !== "approved") {
        return;
      }
      writeReply({
        outbox: join(this.paths.root, "outbox"),
        originalId: message.id,
        to,
        subject,
        body: result.draft,
      });
    });
    const approvalId = this.approvals.pending().at(-1)?.id ?? "";
    if (approvalId.length > 0) {
      this.mailTasks.set(approvalId, task);
      this.openReplies.set(id, approvalId);
    }
    return { approvalId, draft, thread: message.thread };
  }

  private async runLocalTool(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      return JSON.stringify({ cancelled: true });
    }
    if (call.name === "browser.open") {
      return this.openBrowser(call.arguments, signal);
    }
    if (call.name === "browser.read") {
      return this.driveAction(
        (active) => this.drive.read(browserTarget(call.arguments), active),
        signal,
      );
    }
    if (call.name === "browser.navigate") {
      return this.driveAction(
        (active) => this.drive.navigate(browserUrl(call.arguments), active),
        signal,
      );
    }
    if (call.name === "browser.click") {
      const target = browserClickTarget(call.arguments);
      if (target.length === 0) {
        return JSON.stringify({
          ok: false,
          allowed: false,
          message: "browser.click needs a selector or visible text.",
        });
      }
      return this.driveAction(
        (active) => this.drive.click(target, active),
        signal,
      );
    }
    if (call.name === "browser.type") {
      const typed = browserTypeArgs(call.arguments);
      if (!typed) {
        return JSON.stringify({
          ok: false,
          allowed: false,
          message: "browser.type needs a selector and text.",
        });
      }
      return this.driveAction(
        (active) => this.drive.type(typed.selector, typed.text, active),
        signal,
      );
    }
    if (call.name === "browser.screenshot") {
      return this.driveAction(
        (active) => this.drive.screenshot(active),
        signal,
      );
    }
    if (call.name === "revenue.read") {
      const view = this.revenue();
      return JSON.stringify({ total: view.total, rows: view.rows });
    }
    if (call.name === "mail.summary") {
      const mail = this.mailbox();
      return JSON.stringify({
        count: mail.count,
        digest: mail.digest,
        followUps: mail.followUps,
      });
    }
    if (call.name === "memory.recall") {
      let query = "";
      try {
        const parsed = JSON.parse(call.arguments) as { query?: string };
        query = typeof parsed.query === "string" ? parsed.query : "";
      } catch {
        query = call.arguments;
      }
      const facts =
        query.length > 0 ? await this.recallFacts(query) : this.memory.list();
      return JSON.stringify(facts);
    }
    throw new Error(`Unknown tool ${call.name}`);
  }

  private async openBrowser(
    raw: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = browserUrl(raw);
    if (signal?.aborted) {
      return JSON.stringify({ url, opened: false, cancelled: true });
    }
    const session = this.ensure();
    const pending = this.browser.read(url, (target) =>
      loadPageHtml(target, signal),
    );
    const item = this.approvals.pending().at(-1);
    const approvalId = item?.capability === "browser.visit" ? item.id : "";
    if (approvalId.length > 0 && item) {
      session.chat.messages.push({
        role: "approval",
        text: item.summary,
        approvalId,
      });
    }
    const result = await pending;
    const entry = session.chat.messages.find(
      (message) => message.approvalId === approvalId,
    );
    if (result.cancelled || signal?.aborted) {
      markApproval(entry, "(cancelled)");
      return JSON.stringify({
        url,
        opened: false,
        cancelled: true,
        title: "",
        headings: [],
        text: "",
      });
    }
    if (!result.opened) {
      markApproval(entry, "(denied)");
      return JSON.stringify({
        url,
        opened: false,
        title: "",
        headings: [],
        text: "",
      });
    }
    markApproval(entry, "(approved)");
    return JSON.stringify(result);
  }

  private async driveAction(
    start: (signal?: AbortSignal) => Promise<DriveResult>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      return JSON.stringify({
        ok: false,
        allowed: false,
        cancelled: true,
        message: "Stopped.",
      });
    }
    const session = this.ensure();
    const before = new Set(this.approvals.pending().map((item) => item.id));
    const pending = start(signal);
    const item = this.approvals
      .pending()
      .find((entry) => !before.has(entry.id));
    if (item) {
      session.chat.messages.push({
        role: "approval",
        text: item.summary,
        approvalId: item.id,
      });
    }
    let result: DriveResult;
    try {
      result = await pending;
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        markApproval(
          session.chat.messages.find(
            (message) => message.approvalId === item?.id,
          ),
          "(cancelled)",
        );
        return JSON.stringify({
          ok: false,
          allowed: false,
          cancelled: true,
          message: "Stopped.",
        });
      }
      throw error;
    }
    const entry = item
      ? session.chat.messages.find((message) => message.approvalId === item.id)
      : undefined;
    if (result.cancelled || signal?.aborted) {
      markApproval(entry, "(cancelled)");
      return JSON.stringify({ ...result, cancelled: true });
    }
    if (
      entry &&
      result.ok !== true &&
      typeof result.message === "string" &&
      result.message.length > 0
    ) {
      entry.text = `${entry.text} ${result.message}`;
    }
    if (item) {
      markApproval(entry, result.allowed ? "(approved)" : "(denied)");
    }
    return JSON.stringify(result);
  }

  private async fillPageText(session: Session, url: string): Promise<void> {
    const assistant = [...session.chat.messages]
      .reverse()
      .find((item) => item.role === "assistant");
    if (!assistant?.text.startsWith("Opened ")) {
      return;
    }
    const raw = await this.runLocalTool({
      name: "browser.read",
      arguments: JSON.stringify({ url }),
    });
    try {
      const page = JSON.parse(raw) as { title?: string; text?: string };
      const text = typeof page.text === "string" ? page.text.trim() : "";
      if (text.length === 0) {
        return;
      }
      const title =
        typeof page.title === "string" && page.title.length > 0
          ? `${page.title}. `
          : "";
      assistant.text = `${title}${text}`.slice(0, 2_000);
    } catch {
      // The navigate result stays.
    }
  }

  private markGeneralKnowledge(session: Session): void {
    const assistant = [...session.chat.messages]
      .reverse()
      .find((item) => item.role === "assistant");
    if (!assistant || /general knowledge/i.test(assistant.text)) {
      return;
    }
    assistant.text =
      `I didn't open the page, so this is general knowledge, not the live site. ${assistant.text}`.trim();
  }

  private groundRevenue(session: Session): void {
    const view = this.revenue();
    const last = [...session.chat.messages]
      .reverse()
      .find((item) => item.role === "assistant");
    if (!last) {
      return;
    }
    const rows = view.rows
      .map((row) => `${row.vertical} ${row.amount}`)
      .join(", ");
    const grounded = `The total in revenue.csv is ${view.total} (${rows}).`;
    if (deniesAccess(last.text) || !last.text.includes(String(view.total))) {
      last.text = grounded;
    }
  }

  private planWidget(params: unknown) {
    const spec = specOf(params);
    const rows = this.rows();
    const preview = previewWidget(spec, rows);
    this.plan = { spec, preview };
    return {
      spec,
      preview,
      steps: steps("pending"),
    };
  }

  private installWidget(params: unknown) {
    if (!this.plan) {
      this.planWidget(params);
    }
    const planned = this.plan;
    if (!planned) {
      throw new Error("Write a widget description before installing.");
    }
    this.widgetCount += 1;
    const id = `${planned.spec.display}-${this.widgetCount}`;
    const approvalId = this.builder.requestInstall(
      planned.spec,
      this.rows(),
      id,
    );
    return {
      approvalId,
      spec: planned.spec,
      preview: planned.preview,
      steps: steps("waiting"),
    };
  }

  private ensure(): Session {
    const existing = this.sessions.find((item) => item.id === this.activeId);
    if (existing) {
      return existing;
    }
    return this.addSession();
  }

  private addSession(): Session {
    this.nextSession += 1;
    const session: Session = {
      id: `session-${this.nextSession}`,
      title: "New chat",
      chat: new ChatSession(
        this.adapter,
        this.settings,
        this.approvals,
        this.now,
      ),
      streaming: false,
    };
    this.sessions.push(session);
    this.activeId = session.id;
    return session;
  }

  private view(session: Session) {
    return {
      sessions: this.sessions.map((item) => ({
        id: item.id,
        title: item.title,
      })),
      activeId: session.id,
      messages: session.chat.messages,
      streaming: session.streaming,
      models: this.selected(),
      notice: this.notice,
    };
  }

  private selected(): Record<RoleName, string> {
    return {
      chat: this.settings.get("chat"),
      agent: this.settings.get("agent"),
      builder: this.settings.get("builder"),
    };
  }

  private browserPending(): { id: string; summary: string } | undefined {
    const item = this.approvals
      .pending()
      .find((entry) => entry.capability.startsWith("browser."));
    if (!item) {
      return undefined;
    }
    return { id: item.id, summary: item.summary };
  }

  private failText(error: unknown, model: string): string {
    const text =
      error instanceof Error ? error.message : "The model did not answer.";
    if (text.includes("ollama pull")) {
      return text;
    }
    if (
      /not running|ECONNREFUSED|fetch failed|Failed to fetch|network|timed out/i.test(
        text,
      )
    ) {
      return ollamaDownMessage(model);
    }
    return text;
  }
}

const LOCAL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "revenue.read",
      description:
        "Read the local revenue.csv file and return its rows and total.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "mail.summary",
      description: "Read the local mailbox digest and follow-ups.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "memory.recall",
      description: "Recall facts saved on this machine.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser.open",
      description: "Read a page. The first visit waits for approval.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser.read",
      description:
        "Read the open page, or fetch a URL. The first visit waits for approval.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser.navigate",
      description: "Open a URL in Chrome. Waits for approval.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser.click",
      description: "Click a selector or visible text. Waits for approval.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser.type",
      description: "Type into a field. Waits for approval.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser.screenshot",
      description: "Save a screenshot of the open page.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function directBrowse(text: string): { url: string; read: boolean } | null {
  const trimmed = text.trim();
  const open = /^(?:please\s+)?(?:open|visit|go to)\s+(\S+)\s*$/i.exec(trimmed);
  if (open) {
    const url = siteUrl(open[1] ?? "");
    if (url) {
      return { url, read: false };
    }
  }
  if (!asksLivePage(trimmed)) {
    return null;
  }
  const url = siteUrl(trimmed);
  return url ? { url, read: true } : null;
}

function asksLivePage(text: string): boolean {
  return (
    /\b(?:what(?:'s| is) on|what does|what(?:'s| is) (?:the )?(?:latest|current))\b/i.test(
      text,
    ) && /\b(?:page|site|website|homepage)\b/i.test(text)
  );
}

function siteUrl(raw: string): string | null {
  const cleaned = raw.replace(/[.,?!]+$/g, "");
  const match = /((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?/i.exec(cleaned);
  const host = match?.[1] ?? "";
  if (host.length < 4 || !host.includes(".")) {
    return null;
  }
  return `https://${host}`;
}

function localQuestion(text: string): "revenue" | "mail" | "memory" | null {
  const question = text.trim().toLowerCase();
  const asking =
    question.endsWith("?") ||
    /^(what|how|show|list|which|where)\b/.test(question);
  if (!asking) {
    return null;
  }
  if (/revenue\.csv|\brevenue\b/.test(question)) {
    return "revenue";
  }
  if (/\b(mail|inbox|digest|follow-ups?)\b/.test(question)) {
    return "mail";
  }
  if (/\b(memory|remembered|saved facts?)\b/.test(question)) {
    return "memory";
  }
  return null;
}

function toolPrompt(): string {
  return [
    "Tools: revenue.read, mail.summary, memory.recall, browser.read, browser.navigate, browser.click, browser.type, browser.screenshot.",
    "Use a browser tool only when the user explicitly asks to look something up, search, open, visit, read a page, or go to a URL.",
    "If they ask what a website or page currently shows, call browser.navigate and then browser.read. Do not answer that from memory.",
    "When the user asks to open or visit a site, call browser.navigate again even if an earlier reply already said it was open.",
    "If you did not browse, say you are answering from general knowledge, not from the live page.",
    "Small talk and preference statements do not need the browser.",
    "Do not request a page visit just because the answer is missing.",
    "Browser actions still wait for approval.",
    "Do not say you cannot browse.",
    "If a browser tool result includes no page text, say only whether the page opened. Do not describe the page.",
  ].join(" ");
}

function browserTarget(raw: string): string | undefined {
  const record = toolRecord(raw);
  const url = argString(record, "url");
  if (url.length > 0) {
    return browserUrl(JSON.stringify({ url }));
  }
  if (raw.trim().startsWith("{") || raw.trim().length === 0) {
    return undefined;
  }
  return browserUrl(raw);
}

function browserClickTarget(raw: string): string {
  const record = toolRecord(raw);
  const target = argString(record, "target", "selector", "text");
  if (target.length > 0) {
    return target;
  }
  if (raw.trim().startsWith("{")) {
    return "";
  }
  return raw.trim();
}

function browserTypeArgs(
  raw: string,
): { selector: string; text: string } | null {
  const record = toolRecord(raw);
  const selector = argString(record, "selector", "target");
  const text = typeof record.text === "string" ? record.text : "";
  if (selector.length === 0 || text.length === 0) {
    return null;
  }
  return { selector, text };
}

function toolRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The model sometimes sends plain text.
  }
  return {};
}

function argString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function browserUrl(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { url?: string };
      if (typeof parsed.url === "string" && parsed.url.trim().length > 0) {
        text = parsed.url.trim();
      }
    } catch {
      // The model sometimes sends a URL as plain text.
    }
  }
  if (!/^https?:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  return new URL(text).toString();
}

function settled(text: string): boolean {
  return (
    text.includes("(approved)") ||
    text.includes("(denied)") ||
    text.includes("(cancelled)")
  );
}

function markApproval(entry: { text: string } | undefined, mark: string): void {
  if (!entry || settled(entry.text) || entry.text.includes(mark)) {
    return;
  }
  entry.text = `${entry.text} ${mark}`;
}

async function loadPageHtml(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await fetch(url, { signal });
    return (await response.text()).slice(0, 500_000);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return "";
  }
}

function deniesAccess(text: string): boolean {
  return /cannot|can't|do not have|don't have|no access|unable to (read|access)|no file/i.test(
    text,
  );
}

function steps(install: "pending" | "waiting") {
  return [
    { name: "Draft", state: "done" },
    { name: "Generate", state: "done" },
    { name: "Check", state: "done" },
    { name: "Install", state: install },
  ];
}

function specOf(params: unknown): WidgetSpec {
  const record = asRecord(params);
  const template = stringField(record, "template");
  if (template === "kpi" || template === "table" || template === "alert") {
    return templateSpec(template);
  }
  const prompt = stringField(record, "prompt", "text");
  if (prompt.length === 0) {
    throw new Error(
      "Choose a template or describe the widget, for example “show total revenue as a big number”.",
    );
  }
  try {
    return specFromRequest(prompt);
  } catch {
    throw new Error(
      "The builder could not make a spec from that sentence. Try “show total revenue as a big number”, “show revenue as a table”, or “alert when revenue drops”.",
    );
  }
}

function cardHealth(
  id: string,
  input: {
    loaded: "healthy" | "unhealthy" | undefined;
    revenue: boolean;
    mail: boolean;
    ollama: boolean;
    browser: boolean;
  },
): "healthy" | "unhealthy" {
  if (id === "hello" || id === "ollama") {
    if (id === "ollama" && !input.ollama) {
      return "unhealthy";
    }
    return input.loaded === "unhealthy" ? "unhealthy" : "healthy";
  }
  if (id === "files") {
    return input.revenue ? "healthy" : "unhealthy";
  }
  if (id === "mail") {
    return input.mail ? "healthy" : "unhealthy";
  }
  if (id === "browser") {
    return input.browser ? "healthy" : "unhealthy";
  }
  return "healthy";
}

function canRead(path: string): boolean {
  return existsSync(path);
}

function act(
  queue: Approvals,
  params: unknown,
): ReturnType<Approvals["pending"]> {
  const record = asRecord(params);
  const id = stringField(record, "id");
  const action = stringField(record, "action");
  if (action === "approve") {
    queue.approve(id, record.scope === "task" ? "task" : "once");
  } else if (action === "deny") {
    queue.deny(id);
  } else if (action === "more-info") {
    queue.moreInfo(id, stringField(record, "instruction"));
  } else if (action === "edit") {
    queue.edit(id, stringField(record, "draft"));
  } else if (action === "snooze") {
    const until =
      typeof record.until === "number" ? record.until : Date.now() + 60_000;
    queue.snooze(id, until);
  } else {
    throw new Error(
      "Unknown approval action. Use approve, deny, edit, more-info, or snooze.",
    );
  }
  return queue.pending();
}

export function modelNotInstalledMessage(model: string): string {
  return `${model} is not installed. Run \`ollama pull ${model}\`.`;
}

export function ollamaDownMessage(model: string): string {
  return `Ollama is not running at 127.0.0.1:11434. Install it from https://ollama.com/download, then run \`ollama pull ${model}\`.`;
}

function stringField(value: unknown, ...keys: string[]): string {
  const record = asRecord(value);
  for (const key of keys) {
    const item = record[key];
    if (typeof item === "string") {
      return item;
    }
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
