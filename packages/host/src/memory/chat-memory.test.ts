import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeExtractor, ExtractionFailedError } from "memory-bank";
import {
  CHAT_RECALL_TOKEN_BUDGET,
  ChatMemory,
  memoryBankFile,
} from "./chat-memory.ts";

test("retain stores the finished exchange and a failed retain writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-memory-retain-"));
  const seen: string[] = [];
  const saved = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor((input) => {
      seen.push(input.content);
      return [
        {
          text: "The revenue total is 220.",
          kind: "world",
          occurrenceTime: null,
          entities: [],
        },
      ];
    }),
  });
  const failed = new ChatMemory({
    dataDir: mkdtempSync(join(tmpdir(), "pa-memory-retain-fail-")),
    extractor: createFakeExtractor(() => {
      throw new ExtractionFailedError("the model reply was not usable");
    }),
  });
  try {
    await saved.retainExchange(
      "the revenue total is 220",
      "The total in revenue.csv is 220.",
    );
    await failed.retainExchange(
      "the revenue total is 220",
      "The total in revenue.csv is 220.",
    );

    expect(seen).toEqual([
      "User:\nthe revenue total is 220\n\nAssistant:\nThe total in revenue.csv is 220.",
    ]);
    expect(saved.list().map((fact) => fact.text)).toEqual([
      "The revenue total is 220.",
    ]);
    expect(failed.list()).toEqual([]);
    expect(await failed.recallFacts("revenue")).toEqual([]);
    expect(countRows(failed, "facts")).toBe(0);
    expect(countRows(failed, "sources")).toBe(0);
  } finally {
    saved.close();
    failed.close();
  }
});

test("recall returns facts inside the chat token budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-memory-budget-"));
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
  });
  try {
    const long = `pepper ${"x".repeat(2_000)}`;
    await memory.remember(long);
    await memory.remember("pepper is on the shelf");

    const recalled = await memory.recallFacts("pepper");

    expect(CHAT_RECALL_TOKEN_BUDGET).toBe(400);
    expect(recalled.map((fact) => fact.text)).toEqual([
      "pepper is on the shelf",
    ]);
  } finally {
    memory.close();
  }
});

test("a closed bank recalls nothing and does not throw", async () => {
  const memory = new ChatMemory({
    dataDir: mkdtempSync(join(tmpdir(), "pa-memory-closed-")),
    extractor: createFakeExtractor(() => []),
  });
  await memory.remember("pepper is on the shelf");
  memory.close();

  expect(await memory.recallFacts("pepper")).toEqual([]);
});

test("remember writes a fact the same bank can recall", async () => {
  const memory = new ChatMemory({
    dataDir: mkdtempSync(join(tmpdir(), "pa-memory-remember-")),
    agentId: "chat",
    extractor: createFakeExtractor(() => []),
  });
  try {
    const saved = await memory.remember("Maya's dog is named Pepper.");

    expect(saved).toEqual({
      id: saved.id,
      text: "Maya's dog is named Pepper.",
      source: "chat",
    });
    expect(memory.list()).toEqual([saved]);
    expect(await memory.recallFacts("Pepper")).toEqual([saved]);
    memory.delete(saved.id);
    expect(memory.list()).toEqual([]);
    expect(await memory.recallFacts("Pepper")).toEqual([]);
  } finally {
    memory.close();
  }
});

test("banks for different agents do not leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-memory-banks-"));
  const alpha = new ChatMemory({
    dataDir: dir,
    agentId: "alpha",
    extractor: createFakeExtractor(() => []),
  });
  const beta = new ChatMemory({
    dataDir: dir,
    agentId: "beta",
    extractor: createFakeExtractor(() => []),
  });
  try {
    const secret = await alpha.remember("Alpha keeps a private pepper jar.");
    await beta.remember("Beta waters the office fern.");

    expect(await beta.recallFacts("pepper")).toEqual([]);
    expect(beta.list().map((fact) => fact.text)).toEqual([
      "Beta waters the office fern.",
    ]);
    beta.delete(secret.id);
    expect(alpha.list().map((fact) => fact.text)).toEqual([
      "Alpha keeps a private pepper jar.",
    ]);
    expect(
      (await alpha.recallFacts("pepper")).map((fact) => fact.text),
    ).toEqual(["Alpha keeps a private pepper jar."]);
    expect(memoryBankFile(dir)).toBe(join(dir, "memory-bank.sqlite"));
  } finally {
    alpha.close();
    beta.close();
  }
});

function countRows(memory: ChatMemory, table: "facts" | "sources"): number {
  const db = new Database(memory.file, { readonly: true });
  try {
    const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return row.n;
  } finally {
    db.close();
  }
}
