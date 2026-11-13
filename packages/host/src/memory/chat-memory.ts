import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  createOllamaExtractor,
  type Extractor,
  type MemoryBank,
  openBank,
} from "memory-bank";
import type { MemoryFact } from "./memory.ts";

/** Facts placed in one chat prompt. estimateTokens is ceil(characters / 4). */
export const CHAT_RECALL_TOKEN_BUDGET = 400;

/** The conversational agent. Another id in the same file cannot read these facts. */
export const CHAT_AGENT_ID = "chat";

/** Same host the chat connector uses. The library sends think: false. */
export const DEFAULT_MEMORY_HOST = "http://127.0.0.1:11434";

/** Used when the agent model setting is empty. Matches memory-bank. */
export const DEFAULT_MEMORY_MODEL = "qwen3:8b";

export function memoryBankFile(dataDir: string): string {
  return join(dataDir, "memory-bank.sqlite");
}

/** What chat and the Memory page call. Tests can stand in a client that throws. */
export type ChatMemoryClient = {
  recallFacts(query: string): Promise<MemoryFact[]>;
  retainExchange(user: string, assistant: string): Promise<void>;
  remember(text: string): Promise<MemoryFact>;
  list(): MemoryFact[];
  delete(id: string): void;
  settle(): Promise<void>;
  close(): void;
};

export type ChatMemoryOptions = {
  dataDir: string;
  agentId?: string;
  /** When omitted, retain calls Ollama with the agent model and thinking off. */
  extractor?: Extractor;
  model?: () => string;
  host?: string;
};

/**
 * One agent's memory-bank. retain runs after a finished exchange.
 * remember and recall do not call a model. Failures from retain and recall
 * are swallowed so chat can continue.
 */
export class ChatMemory implements ChatMemoryClient {
  readonly file: string;
  private readonly agentId: string;
  private readonly bank: MemoryBank;
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(options: ChatMemoryOptions) {
    const agentId = options.agentId?.trim() || CHAT_AGENT_ID;
    this.agentId = agentId;
    this.file = memoryBankFile(options.dataDir);
    this.bank = openBank(this.file, {
      bankId: agentId,
      extractor:
        options.extractor ?? ollamaExtractor(options.model, options.host),
    });
  }

  async recallFacts(query: string): Promise<MemoryFact[]> {
    try {
      const result = await this.bank.recall({
        query,
        tokenBudget: CHAT_RECALL_TOKEN_BUDGET,
      });
      return result.facts.map((fact) => this.view(fact.id, fact.text));
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
    const saved = await this.bank.remember({ text });
    return this.view(saved.id, saved.text);
  }

  list(): MemoryFact[] {
    return readFacts(this.file, this.agentId);
  }

  delete(id: string): void {
    const factId = id.trim();
    if (factId.length === 0) {
      return;
    }
    const db = new Database(this.file);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA foreign_keys = ON;");
      const remove = db.transaction(() => {
        db.query("DELETE FROM edges WHERE bank_id = ? AND fact_id = ?").run(
          this.agentId,
          factId,
        );
        db.query("DELETE FROM facts WHERE bank_id = ? AND id = ?").run(
          this.agentId,
          factId,
        );
      });
      remove();
    } finally {
      db.close();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.bank.close();
    } catch (error) {
      this.note("memory close failed", error);
    }
  }

  private async keep(user: string, assistant: string): Promise<void> {
    const userText = user.trim();
    const assistantText = assistant.trim();
    if (userText.length === 0 || assistantText.length === 0) {
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

  private view(id: string, text: string): MemoryFact {
    return { id, text, source: this.agentId };
  }

  private note(label: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : "unknown";
    if (/closed/i.test(detail)) {
      return;
    }
    console.error(`${label}: ${detail}`);
  }
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

function readFacts(file: string, agentId: string): MemoryFact[] {
  const db = new Database(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const rows = db
      .query(
        "SELECT id, text FROM facts WHERE bank_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(agentId) as { id: string; text: string }[];
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      source: agentId,
    }));
  } finally {
    db.close();
  }
}
