import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ActivityEntry, Approvals } from "./approvals/approvals.ts";
import { decide } from "./broker/broker.ts";
import {
  previewWidget,
  specFromRequest,
  templateSpec,
  WidgetBuilder,
  type WidgetSpec,
} from "./builder/builder.ts";
import { adviceFor, machineChecks } from "./capabilities/live.ts";
import { type DemoPaths, seedDemoData } from "./data/demo.ts";
import { loadRevenueView, type RevenueView } from "./files/snapshot.ts";
import type { RevenueRow } from "./files/table.ts";
import {
  followUps,
  loadMailbox,
  openMailState,
  recentThreads,
  writeReply,
} from "./mail/mail.ts";
import { MAIL_USER } from "./mail/sample.ts";
import { MemoryStore } from "./memory/memory.ts";
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
    summary: "Keeps facts you save on this machine.",
    permissions: [
      "Stores facts for this app on this machine.",
      "This version does not encrypt memory.",
    ],
  },
  {
    id: "browser",
    name: "Browser",
    summary: "Can open a page after you approve the site.",
    permissions: [
      "The first visit to a site waits on Approvals.",
      "You stop the session from the browser task.",
    ],
  },
];

export type DesktopOptions = {
  dataDir: string;
  adapter?: ModelAdapter;
  probe?: () => Promise<"running" | "stopped">;
  now?: () => number;
  audit?: (entry: ActivityEntry) => void;
};

/** The packaged host: widgets, chat, sample data, and the pages' RPC methods. */
export class DesktopApp {
  readonly settings = new ModelSettings();
  private readonly kernel = new PluginKernel();
  private readonly memory = new MemoryStore();
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

  constructor(options: DesktopOptions) {
    this.adapter =
      options.adapter ?? new OllamaConnector((url, init) => fetch(url, init));
    this.probe = options.probe ?? (() => probeOllama());
    this.now = options.now ?? Date.now;
    this.approvals = new Approvals(options.audit ?? (() => {}));
    this.builder = new WidgetBuilder(
      this.kernel,
      this.approvals,
      this.settings,
    );
    this.paths = seedDemoData(options.dataDir);
  }

  async start(): Promise<void> {
    await this.kernel.load(HELLO_PLUGIN_SOURCE);
    await this.kernel.load(OLLAMA_PLUGIN_SOURCE);
  }

  close(): void {
    this.kernel.close();
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
        session.chat.stop();
        session.streaming = false;
        return JSON.stringify(this.view(session));
      },
      chat_approve: (params) => {
        const session = this.ensure();
        session.chat.approveInline(stringField(params, "id"));
        return JSON.stringify(this.view(session));
      },
      mail_state: () => JSON.stringify(this.mailbox()),
      mail_draft: async (params) =>
        JSON.stringify(await this.draftReply(params)),
      memory_list: () => JSON.stringify(this.memory.view()),
      memory_remember: (params) => {
        const text = stringField(params, "text").trim();
        if (text.length === 0) {
          throw new Error("Write a fact before saving it.");
        }
        const source =
          stringField(params, "sessionId", "session_id") || this.ensure().id;
        return JSON.stringify(this.memory.remember(source, text));
      },
      memory_delete: (params) => {
        this.memory.delete(stringField(params, "id"));
        return JSON.stringify(this.memory.view());
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
    if (isFact(text)) {
      this.memory.remember(session.id, text.trim());
    }
    const recalled = text.trim().endsWith("?") ? this.memory.recall(text) : [];
    const kind = localQuestion(text);
    const remembered =
      recalled.length > 0
        ? recalled
            .map((fact) => `${fact.text} (source ${fact.source})`)
            .join("\n")
        : "";
    const context = [toolPrompt(kind), remembered]
      .filter((part) => part.length > 0)
      .join("\n");
    session.streaming = true;
    try {
      await session.chat.send(
        text,
        context.length > 0 ? context : undefined,
        kind
          ? {
              model: this.settings.get("agent"),
              definitions: LOCAL_TOOLS,
              runTool: (call) => this.runLocalTool(call),
            }
          : undefined,
      );
      for (const fact of recalled) {
        session.chat.messages.push({
          role: "memory",
          text: `${fact.text} (source ${fact.source})`,
        });
      }
    } catch (error) {
      const last = session.chat.messages.at(-1);
      if (last?.role === "assistant") {
        last.text = this.failText(error, this.settings.get("chat"));
      }
    } finally {
      session.streaming = false;
    }
    if (kind === "revenue") {
      this.groundRevenue(session);
    }
    return JSON.stringify(this.view(session));
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
    let draft = `Thanks for the note about ${message.thread}.`;
    try {
      if ((await this.probe()) === "running") {
        const result = await this.adapter.chat(
          {
            model: this.settings.get("chat"),
            messages: [
              {
                role: "user",
                content: `Write a short reply from ${MAIL_USER}.\nFrom: ${message.from}\nSubject: ${message.subject}\n\n${message.body}`,
              },
            ],
          },
          () => {},
        );
        if (result.text.trim().length > 0) {
          draft = result.text.trim();
        }
      }
    } catch {
      // The local sentence is enough for the approval draft.
    }
    const subject = message.subject.startsWith("Re:")
      ? message.subject
      : `Re: ${message.subject}`;
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
        to: message.from,
        subject,
        body: result.draft,
      });
    });
    const approvalId = this.approvals.pending().at(-1)?.id ?? "";
    if (approvalId.length > 0) {
      this.mailTasks.set(approvalId, task);
    }
    return { approvalId, draft, thread: message.thread };
  }

  private async runLocalTool(call: ToolCall): Promise<string> {
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
        query.length > 0 ? this.memory.recall(query) : this.memory.view();
      return JSON.stringify(facts);
    }
    throw new Error(`Unknown tool ${call.name}`);
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
];

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

function toolPrompt(kind: "revenue" | "mail" | "memory" | null): string {
  if (!kind) {
    return "";
  }
  return "You can read this machine's files with tools. Call revenue.read for revenue.csv, mail.summary for the mailbox, and memory.recall for saved facts. Do not say you lack file access.";
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

function isFact(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length >= 12 && !trimmed.endsWith("?") && /\bis\b/i.test(trimmed)
  );
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
