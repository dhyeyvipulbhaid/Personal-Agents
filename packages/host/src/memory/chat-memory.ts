import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createOllamaExtractor,
  createOllamaReflector,
  type Embedder,
  type Extractor,
  encryptBank,
  type GraphSnapshot,
  type MemoryBank,
  type ObservationRecord,
  openBank,
  parseEncryptionKey,
  type Reflector,
} from "memory-bank";
import type { MemoryFact } from "./memory.ts";
import { transientFactReason } from "./transient.ts";

/** Facts placed in one chat prompt. estimateTokens is ceil(characters / 4). */
export const CHAT_RECALL_TOKEN_BUDGET = 400;

/** The conversational agent. Another id in the same file cannot read these facts. */
export const CHAT_AGENT_ID = "chat";

/** Same host the chat connector uses. The library sends think: false. */
export const DEFAULT_MEMORY_HOST = "http://127.0.0.1:11434";

/** Used when the agent model setting is empty. Matches memory-bank. */
export const DEFAULT_MEMORY_MODEL = "qwen3:8b";

/** Embedding model for hybrid recall. Override it from Memory settings. */
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

/** Wait this long after the last chat turn before an idle reflect. */
export const REFLECT_IDLE_MS = 5 * 60 * 1000;

/** Minimum gap between idle reflects on one agent bank. */
export const REFLECT_PERIOD_MS = 15 * 60 * 1000;

const PAGE_LIMIT = 20;

export const MISSING_KEY_MESSAGE =
  "Memory is encrypted, but the key is missing from the macOS Keychain or Windows Credential Manager.";

export const WRONG_KEY_MESSAGE = "The key does not match this memory file.";

export function memoryBankFile(dataDir: string): string {
  return join(dataDir, "memory-bank.sqlite");
}

export function memorySettingsFile(dataDir: string): string {
  return join(dataDir, "memory-settings.json");
}

/** Strips a secret out of a log line. The key itself is never written. */
export function redactSecret(text: string, secret: string): string {
  const hidden = secret.trim();
  if (hidden.length === 0) {
    return text;
  }
  return text.split(hidden).join("[redacted]");
}

export type EmbedText = (
  model: string,
  text: string,
) => Promise<readonly number[]> | readonly number[];

export type MemoryPage = {
  facts: MemoryFact[];
  total: number;
  offset: number;
  limit: number;
};

export type MemoryStatus = {
  embeddingModel: string;
  includeObservations: boolean;
  encryptionEnabled: boolean;
  error: string;
};

export type SweepView = {
  dryRun: boolean;
  candidates: { id: string; text: string; reason: string }[];
  deleted: number;
};

export type GraphView = GraphSnapshot & {
  texts: Record<string, string>;
};

export type EncryptView = {
  backup: string;
  fields: number;
  alreadyEncrypted: boolean;
};

/** What chat and the Memory page call. Tests can stand in a client that throws. */
export type ChatMemoryClient = {
  recallFacts(query: string): Promise<MemoryFact[]>;
  retainExchange(user: string, assistant: string): Promise<void>;
  remember(text: string): Promise<MemoryFact>;
  list(): MemoryFact[];
  delete(id: string): void;
  settle(): Promise<void>;
  close(): void;
  listPage?(input: PageQuery): MemoryPage;
  update?(id: string, text: string): Promise<MemoryFact>;
  deleteMany?(ids: string[]): { removedFactIds: string[] };
  sweep?(dryRun: boolean): SweepView;
  graph?(): Promise<GraphView>;
  observations?(): Promise<MemoryFact[]>;
  reflect?(input?: { query?: string }): Promise<MemoryFact[]>;
  reflectIfDue?(
    now?: number,
    idleMs?: number,
    periodMs?: number,
  ): Promise<MemoryFact[] | null>;
  startIdleReflect?(options?: IdleReflectOptions): void;
  stopIdleReflect?(): void;
  noteActivity?(now?: number): void;
  backfillEmbeddings?(): Promise<{ embedded: number; remaining: number }>;
  setEmbeddingModel?(name: string): void;
  setIncludeObservations?(value: boolean): void;
  embeddingModel?(): string;
  includeObservations?(): boolean;
  status?(): MemoryStatus;
  encrypt?(key: string): EncryptView;
  unlock?(key: string): void;
};

export type PageQuery = {
  limit?: number;
  offset?: number;
  kind?: string;
  entity?: string;
  query?: string;
};

export type IdleReflectOptions = {
  idleMs?: number;
  periodMs?: number;
  intervalMs?: number;
};

export type ChatMemoryOptions = {
  dataDir: string;
  agentId?: string;
  /** When omitted, retain calls Ollama with the agent model and thinking off. */
  extractor?: Extractor;
  model?: () => string;
  host?: string;
  /**
   * Embeds through the host Ollama connector. Omit it and hybrid recall
   * keeps working on keywords, entities, and time.
   */
  embed?: EmbedText;
  reflector?: Reflector;
  /** Base64 or raw key. Tests pass it. The desktop shell reads the keychain. */
  encryptionKey?: string;
};

type Prefs = {
  embeddingModel: string;
  includeObservations: boolean;
  encryptionEnabled: boolean;
};

/**
 * One agent's memory-bank. Chat recall is hybrid: keywords, vectors, the
 * entity graph, and recency. retain runs after a finished exchange.
 * Failures from retain, recall, and embedding are swallowed so chat can continue.
 */
export class ChatMemory implements ChatMemoryClient {
  readonly file: string;
  private readonly agentId: string;
  private readonly dataDir: string;
  private readonly extractor: Extractor;
  private readonly embedder: Embedder | null;
  private readonly reflector: Reflector;
  private readonly prefsPath: string;
  private bank: MemoryBank | null = null;
  private prefs: Prefs;
  private openError = "";
  private keyInUse = "";
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  private lastActivityAt = Date.now();
  private lastReflectAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ChatMemoryOptions) {
    const agentId = options.agentId?.trim() || CHAT_AGENT_ID;
    this.agentId = agentId;
    this.dataDir = options.dataDir;
    this.file = memoryBankFile(options.dataDir);
    this.prefsPath = memorySettingsFile(options.dataDir);
    this.prefs = readPrefs(this.prefsPath);
    this.extractor = filteringExtractor(
      options.extractor ?? ollamaExtractor(options.model, options.host),
    );
    this.embedder = wrapEmbedder(options.embed, () => this.embeddingModel());
    const host = options.host?.trim() || DEFAULT_MEMORY_HOST;
    this.reflector =
      options.reflector ??
      ({
        reflect(input) {
          return createOllamaReflector({
            model: DEFAULT_MEMORY_MODEL,
            host,
          }).reflect(input);
        },
      } satisfies Reflector);
    const key = options.encryptionKey?.trim() ?? "";
    if (key.length > 0) {
      try {
        this.open(key);
        this.keyInUse = key;
      } catch (error) {
        this.openError = this.publicError(error, key).message;
      }
      return;
    }
    if (this.prefs.encryptionEnabled) {
      this.openError = MISSING_KEY_MESSAGE;
      return;
    }
    try {
      this.open(undefined);
    } catch (error) {
      this.openError = this.publicError(error).message;
    }
  }

  async recallFacts(query: string): Promise<MemoryFact[]> {
    if (this.closed || !this.bank) {
      if (!this.closed && this.openError) {
        this.note("memory recall failed", new Error(this.openError));
      }
      return [];
    }
    try {
      const result = await this.bank.hybridRecall({
        query,
        tokenBudget: CHAT_RECALL_TOKEN_BUDGET,
        includeObservations: this.prefs.includeObservations,
      });
      return result.facts.map((fact) => this.asFact(fact));
    } catch (error) {
      this.note("memory recall failed", error);
      return [];
    }
  }

  retainExchange(user: string, assistant: string): Promise<void> {
    const job = this.keep(user, assistant);
    this.pending.add(job);
    void job.finally(() => {
      this.pending.delete(job);
    });
    return job;
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async remember(text: string): Promise<MemoryFact> {
    const saved = await this.requireBank().remember({ text });
    return this.view(saved.id, saved.text);
  }

  list(): MemoryFact[] {
    const bank = this.requireBank();
    const facts: MemoryFact[] = [];
    let offset = 0;
    for (;;) {
      const page = bank.listFacts({ limit: 100, offset });
      for (const fact of page.facts) {
        facts.push(this.view(fact.id, fact.text));
      }
      offset += page.facts.length;
      if (page.facts.length === 0 || offset >= page.total) {
        break;
      }
    }
    return facts;
  }

  listPage(input: PageQuery = {}): MemoryPage {
    const bank = this.requireBank();
    const limit = clampLimit(input.limit);
    const offset =
      typeof input.offset === "number" && input.offset > 0
        ? Math.floor(input.offset)
        : 0;
    const kind =
      input.kind === "world" || input.kind === "experience"
        ? input.kind
        : undefined;
    const entity = input.entity?.trim() ?? "";
    const query = input.query?.trim() ?? "";
    const page = bank.listFacts({
      limit,
      offset,
      kind,
      entity: entity.length > 0 ? entity : undefined,
      query: query.length > 0 ? query : undefined,
    });
    return {
      facts: page.facts.map((fact) => ({
        ...this.view(fact.id, fact.text),
        kind: fact.kind,
      })),
      total: page.total,
      offset,
      limit,
    };
  }

  async update(id: string, text: string): Promise<MemoryFact> {
    const saved = await this.requireBank().updateFact(id, text);
    return this.view(saved.fact.id, saved.fact.text);
  }

  delete(id: string): void {
    const factId = id.trim();
    if (factId.length === 0) {
      return;
    }
    try {
      this.requireBank().forget(factId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (/No fact with that id/i.test(detail)) {
        return;
      }
      throw this.publicError(error);
    }
  }

  deleteMany(ids: string[]): { removedFactIds: string[] } {
    const unique = [
      ...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
    ];
    if (unique.length === 0) {
      return { removedFactIds: [] };
    }
    const removed = this.requireBank().forgetMany(unique);
    return { removedFactIds: removed.removedFactIds };
  }

  sweep(dryRun: boolean): SweepView {
    const bank = this.requireBank();
    const library = bank.sweepJunk({ dryRun: true });
    const seen = new Set(library.candidates.map((item) => item.id));
    const extra = this.list().flatMap((fact) => {
      const reason = transientFactReason(fact.text);
      if (reason == null || seen.has(fact.id)) {
        return [];
      }
      return [{ id: fact.id, text: fact.text, reason }];
    });
    const candidates = [
      ...library.candidates.map((item) => ({
        id: item.id,
        text: item.text,
        reason: item.reason,
      })),
      ...extra,
    ];
    if (dryRun || candidates.length === 0) {
      return { dryRun: true, candidates, deleted: 0 };
    }
    const applied = bank.sweepJunk({ dryRun: false });
    if (extra.length > 0) {
      bank.forgetMany(extra.map((item) => item.id));
    }
    return {
      dryRun: false,
      candidates,
      deleted: applied.deleted + extra.length,
    };
  }

  async graph(): Promise<GraphView> {
    const snapshot = this.requireBank().graphSnapshot({
      includeObservations: true,
    });
    const texts: Record<string, string> = {};
    for (const fact of this.list()) {
      texts[fact.id] = fact.text;
    }
    for (const item of await this.observations()) {
      texts[item.id] = item.text;
    }
    return { ...snapshot, texts };
  }

  async observations(): Promise<MemoryFact[]> {
    const snapshot = this.requireBank().graphSnapshot({
      includeObservations: true,
      limit: 1000,
    });
    const cited = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      if (edge.type !== "derived") {
        continue;
      }
      const list = cited.get(edge.source) ?? [];
      list.push(edge.target);
      cited.set(edge.source, list);
    }
    const facts = new Map(this.list().map((fact) => [fact.id, fact.text]));
    const items: MemoryFact[] = [];
    for (const node of snapshot.nodes) {
      if (!node.derived) {
        continue;
      }
      const sourceFactIds = cited.get(node.id) ?? [];
      items.push({
        id: node.id,
        text: await this.fullObservationText(node.id, node.label),
        source: this.agentId,
        derived: true,
        sourceFactIds,
        cited: sourceFactIds.map((id) => ({
          id,
          text: facts.get(id) ?? "",
        })),
      });
    }
    return items;
  }

  async reflect(input: { query?: string } = {}): Promise<MemoryFact[]> {
    const query = input.query?.trim() ?? "";
    try {
      const saved = await this.requireBank().reflect(
        query.length > 0 ? { query } : {},
      );
      return this.decorate(saved.observations);
    } catch (error) {
      throw this.publicError(error);
    }
  }

  async reflectIfDue(
    now = Date.now(),
    idleMs = REFLECT_IDLE_MS,
    periodMs = REFLECT_PERIOD_MS,
  ): Promise<MemoryFact[] | null> {
    if (this.closed || !this.bank) {
      return null;
    }
    if (now - this.lastActivityAt < idleMs) {
      return null;
    }
    if (this.lastReflectAt !== 0 && now - this.lastReflectAt < periodMs) {
      return null;
    }
    this.lastReflectAt = now;
    try {
      return await this.reflect({});
    } catch (error) {
      this.note("memory reflect failed", error);
      return [];
    }
  }

  startIdleReflect(options: IdleReflectOptions = {}): void {
    this.stopIdleReflect();
    const idleMs = options.idleMs ?? REFLECT_IDLE_MS;
    const periodMs = options.periodMs ?? REFLECT_PERIOD_MS;
    const intervalMs = options.intervalMs ?? 30_000;
    const timer = setInterval(() => {
      void this.reflectIfDue(Date.now(), idleMs, periodMs);
    }, intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stopIdleReflect(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  noteActivity(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  async backfillEmbeddings(): Promise<{ embedded: number; remaining: number }> {
    if (!this.embedder) {
      return { embedded: 0, remaining: 0 };
    }
    try {
      return await this.requireBank().backfillEmbeddings();
    } catch (error) {
      this.note("memory backfill failed", error);
      return { embedded: 0, remaining: 0 };
    }
  }

  embeddingModel(): string {
    return this.prefs.embeddingModel;
  }

  setEmbeddingModel(name: string): void {
    const model = name.trim();
    if (!/^[A-Za-z0-9_.:@+-]{1,80}$/.test(model)) {
      throw new Error("The embedding model name is not valid.");
    }
    this.prefs.embeddingModel = model;
    this.writePrefs();
  }

  includeObservations(): boolean {
    return this.prefs.includeObservations;
  }

  setIncludeObservations(value: boolean): void {
    this.prefs.includeObservations = value;
    this.writePrefs();
  }

  status(): MemoryStatus {
    return {
      embeddingModel: this.prefs.embeddingModel,
      includeObservations: this.prefs.includeObservations,
      encryptionEnabled: this.prefs.encryptionEnabled,
      error: this.openError,
    };
  }

  encrypt(key: string): EncryptView {
    const secret = key.trim();
    this.assertKey(secret);
    this.closeBank();
    const backup = this.backupPath();
    copyFileSync(this.file, backup);
    try {
      const result = encryptBank(this.file, parseEncryptionKey(secret));
      this.open(secret);
      this.keyInUse = secret;
      this.prefs.encryptionEnabled = true;
      this.writePrefs();
      return {
        backup,
        fields: result.fields,
        alreadyEncrypted: result.alreadyEncrypted,
      };
    } catch (error) {
      this.restoreBackup(backup);
      throw this.publicError(error, secret);
    }
  }

  unlock(key: string): void {
    const secret = key.trim();
    this.assertKey(secret);
    try {
      this.open(secret);
      this.keyInUse = secret;
      this.prefs.encryptionEnabled = true;
      this.openError = "";
      this.writePrefs();
    } catch (error) {
      const wrapped = this.publicError(error, secret);
      this.openError = wrapped.message;
      throw wrapped;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopIdleReflect();
    this.closeBank();
  }

  private async keep(user: string, assistant: string): Promise<void> {
    const userText = user.trim();
    const assistantText = assistant.trim();
    if (userText.length === 0 || assistantText.length === 0 || !this.bank) {
      return;
    }
    try {
      await this.bank.retain({
        content: `User:\n${userText}\n\nAssistant:\n${assistantText}`,
        context: "chat",
      });
    } catch (error) {
      this.note("memory retain failed", error);
    }
  }

  private open(key: string | undefined): void {
    this.closeBank();
    this.bank = openBank(this.file, {
      bankId: this.agentId,
      extractor: this.extractor,
      embedder: this.embedder,
      reflector: this.reflector,
      encryptionKey: key,
    });
    this.openError = "";
    this.scheduleBackfill();
  }

  private closeBank(): void {
    if (!this.bank) {
      return;
    }
    try {
      this.bank.close();
    } catch (error) {
      this.note("memory close failed", error);
    }
    this.bank = null;
  }

  private scheduleBackfill(): void {
    if (!this.embedder || !this.bank) {
      return;
    }
    const job = this.bank
      .backfillEmbeddings()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.note("memory backfill failed", error);
      });
    this.pending.add(job);
    void job.finally(() => {
      this.pending.delete(job);
    });
  }

  private requireBank(): MemoryBank {
    if (this.closed) {
      throw new Error("This memory bank is closed.");
    }
    if (!this.bank) {
      throw new Error(this.openError || "Memory is not open.");
    }
    return this.bank;
  }

  private assertKey(secret: string): void {
    if (secret.length === 0) {
      throw new Error("Memory encryption needs a key from the keychain.");
    }
    try {
      parseEncryptionKey(secret);
    } catch (error) {
      throw this.publicError(error, secret);
    }
  }

  private backupPath(): string {
    const plain = `${this.file}.bak`;
    if (!existsSync(plain)) {
      return plain;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${this.file}.${stamp}.bak`;
  }

  private restoreBackup(backup: string): void {
    try {
      copyFileSync(backup, this.file);
    } catch (error) {
      this.note("memory backup restore failed", error);
    }
    try {
      this.open(undefined);
      this.keyInUse = "";
    } catch (error) {
      this.openError = this.publicError(error).message;
      this.bank = null;
    }
  }

  private decorate(observations: ObservationRecord[]): MemoryFact[] {
    const facts = new Map(this.list().map((fact) => [fact.id, fact.text]));
    return observations.map((item) => ({
      id: item.id,
      text: item.text,
      source: this.agentId,
      derived: true,
      sourceFactIds: item.sourceFactIds,
      cited: item.sourceFactIds.map((id) => ({
        id,
        text: facts.get(id) ?? "",
      })),
    }));
  }

  private async fullObservationText(
    id: string,
    label: string,
  ): Promise<string> {
    if (!label.endsWith("…")) {
      return label;
    }
    const query = label.slice(0, -1).trim();
    if (query.length === 0 || !this.bank) {
      return label;
    }
    try {
      const result = await this.bank.hybridRecall({
        query,
        tokenBudget: 4_000,
        includeObservations: true,
        limit: 20,
      });
      const match = result.facts.find((fact) => fact.id === id);
      return match?.text && match.text.length > 0 ? match.text : label;
    } catch (error) {
      this.note("memory observation read failed", error);
      return label;
    }
  }

  private asFact(fact: {
    id: string;
    text: string;
    derived?: boolean;
    sourceFactIds?: string[];
  }): MemoryFact {
    const view = this.view(fact.id, fact.text);
    if (fact.derived) {
      view.derived = true;
      view.sourceFactIds = fact.sourceFactIds ?? [];
    }
    return view;
  }

  private view(id: string, text: string): MemoryFact {
    return { id, text, source: this.agentId };
  }

  private writePrefs(): void {
    const body = JSON.stringify(
      {
        embeddingModel: this.prefs.embeddingModel,
        includeObservations: this.prefs.includeObservations,
        encryptionEnabled: this.prefs.encryptionEnabled,
      },
      null,
      2,
    );
    writeFileSync(this.prefsPath, `${body}\n`);
  }

  private publicError(error: unknown, secret = ""): Error {
    const raw =
      error instanceof Error ? error.message : "Memory could not be opened.";
    const text = redactSecret(raw, secret || this.keyInUse);
    if (/Wrong encryption key|Ciphertext failed authentication/i.test(text)) {
      return new Error(WRONG_KEY_MESSAGE);
    }
    if (/Pass encryptionKey|database is encrypted/i.test(text)) {
      return new Error(MISSING_KEY_MESSAGE);
    }
    if (/must be 32 bytes/i.test(text)) {
      return new Error(
        "The memory key from the keychain is not a valid 32-byte key.",
      );
    }
    if (/is not encrypted/i.test(text)) {
      return new Error(
        "This memory file is still plaintext. Encrypt it before opening it with a key.",
      );
    }
    return new Error(text);
  }

  private note(label: string, error: unknown): void {
    let detail = error instanceof Error ? error.message : "unknown";
    detail = redactSecret(detail, this.keyInUse);
    if (/closed/i.test(detail)) {
      return;
    }
    console.error(`${label}: ${detail}`);
  }
}

/** memory-bank still stores page-state and assistant-meta lines. Drop them before retain. */
function filteringExtractor(inner: Extractor): Extractor {
  return {
    extract(input) {
      const extracted = inner.extract(input);
      const keep = (facts: Awaited<ReturnType<Extractor["extract"]>>) =>
        facts.filter((fact) => transientFactReason(fact.text) == null);
      if (extracted instanceof Promise) {
        return extracted.then(keep);
      }
      return keep(extracted);
    },
  };
}

function wrapEmbedder(
  embed: EmbedText | undefined,
  model: () => string,
): Embedder | null {
  if (!embed) {
    return null;
  }
  return {
    get model() {
      return model();
    },
    embed(text: string) {
      return embed(model(), text);
    },
  };
}

function ollamaExtractor(
  model: (() => string) | undefined,
  host: string | undefined,
): Extractor {
  const origin = host?.trim() || DEFAULT_MEMORY_HOST;
  return {
    extract(input) {
      const name = model?.().trim() || DEFAULT_MEMORY_MODEL;
      return createOllamaExtractor({ model: name, host: origin }).extract(
        input,
      );
    },
  };
}

function readPrefs(file: string): Prefs {
  const defaults: Prefs = {
    embeddingModel: DEFAULT_EMBED_MODEL,
    includeObservations: true,
    encryptionEnabled: false,
  };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Prefs>;
    const model =
      typeof parsed.embeddingModel === "string"
        ? parsed.embeddingModel.trim()
        : "";
    return {
      embeddingModel: /^[A-Za-z0-9_.:@+-]{1,80}$/.test(model)
        ? model
        : defaults.embeddingModel,
      includeObservations: parsed.includeObservations !== false,
      encryptionEnabled: parsed.encryptionEnabled === true,
    };
  } catch {
    return defaults;
  }
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return PAGE_LIMIT;
  }
  if (value < 1) {
    return 1;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}
