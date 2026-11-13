import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeExtractor,
  createFakeReflector,
  ReflectorUnavailableError,
} from "memory-bank";
import { DesktopApp } from "../desktop.ts";
import type { ModelAdapter } from "../models/adapter.ts";
import {
  ChatMemory,
  DEFAULT_EMBED_MODEL,
  MISSING_KEY_MESSAGE,
  memorySettingsFile,
  WRONG_KEY_MESSAGE,
} from "./chat-memory.ts";

test("hybrid recall finds a paraphrase from embeddings and a time cue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-hybrid-"));
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor((input) => {
      if (input.content.includes("park")) {
        return [
          {
            text: "The dog plays in the park.",
            kind: "world",
            occurrenceTime: new Date(Date.now() - 86_400_000).toISOString(),
            entities: [],
          },
        ];
      }
      return [
        {
          text: "The ledger total is 220.",
          kind: "world",
          occurrenceTime: "2020-01-02T00:00:00.000Z",
          entities: [],
        },
      ];
    }),
    embed(_model, text) {
      if (/dog|pet|park|exercise/.test(text)) {
        return [1, 0, 0];
      }
      return [0, 1, 0];
    },
  });
  try {
    await memory.retainExchange("the dog plays in the park", "noted");
    await memory.retainExchange("the ledger total is 220", "noted");
    await memory.settle();

    const paraphrased = await memory.recallFacts("where does the pet exercise");
    expect(paraphrased.map((fact) => fact.text)).toContain(
      "The dog plays in the park.",
    );
    expect(paraphrased.map((fact) => fact.text)).not.toContain(
      "The ledger total is 220.",
    );

    const dated = new ChatMemory({
      dataDir: mkdtempSync(join(tmpdir(), "pa-hybrid-time-")),
      extractor: createFakeExtractor((input) => {
        const older = input.content.includes("2020");
        const now = new Date();
        const yesterdayNoon = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 1,
            12,
          ),
        ).toISOString();
        return [
          {
            text: older
              ? "The launch slipped in 2020."
              : "The launch moved yesterday.",
            kind: "world",
            occurrenceTime: older ? "2020-01-02T00:00:00.000Z" : yesterdayNoon,
            entities: [],
          },
        ];
      }),
    });
    try {
      await dated.retainExchange("the launch moved yesterday", "noted");
      await dated.retainExchange("the old launch slipped in 2020", "noted");
      await dated.settle();
      const yesterday = await dated.recallFacts("launch yesterday");
      expect(yesterday.map((fact) => fact.text)).toEqual([
        "The launch moved yesterday.",
      ]);
    } finally {
      dated.close();
    }
  } finally {
    memory.close();
  }
});

test("a down embedder still recalls keywords and backfill continues later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-backfill-"));
  const seed = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
  });
  await seed.remember("pepper is on the shelf");
  seed.close();

  let down = true;
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
    embed() {
      if (down) {
        throw new Error("Ollama is not reachable at 127.0.0.1:11434");
      }
      return [0.2, 0.4, 0.8];
    },
  });
  try {
    await memory.settle();
    expect(
      (await memory.recallFacts("pepper")).map((fact) => fact.text),
    ).toEqual(["pepper is on the shelf"]);
    down = false;
    const filled = await memory.backfillEmbeddings();
    expect(filled.embedded).toBe(1);
    expect(filled.remaining).toBe(0);
    expect(logs.join("\n")).not.toContain("0.2, 0.4");
  } finally {
    console.error = original;
    memory.close();
  }
});

test("the embedding model setting is saved and recalled facts can hide observations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-embed-setting-"));
  const reflector = createFakeReflector((input) => [
    {
      text: "Maya keeps morning meetings.",
      confidence: 0.9,
      sourceFactIds: input.facts.slice(0, 2).map((fact) => fact.id),
    },
  ]);
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
    reflector,
  });
  try {
    expect(memory.embeddingModel()).toBe(DEFAULT_EMBED_MODEL);
    memory.setEmbeddingModel("nomic-embed-text");
    expect(() => memory.setEmbeddingModel("has spaces")).toThrow(/not valid/);
    await memory.remember("Maya prefers morning meetings.");
    await memory.remember("Maya writes the agenda the night before.");
    const reflected = await memory.reflect({ query: "Maya meetings" });
    expect(reflected[0]?.derived).toBe(true);
    expect(reflected[0]?.text).toBe("Maya keeps morning meetings.");
    expect(
      reflected[0]?.cited?.map((item) => item.text).filter(Boolean).length,
    ).toBe(2);

    memory.setIncludeObservations(false);
    const hidden = await memory.recallFacts("Maya meetings");
    expect(hidden.some((fact) => fact.derived)).toBe(false);
    memory.setIncludeObservations(true);
    const shown = await memory.recallFacts("Maya meetings");
    expect(
      shown.some((fact) => fact.text === "Maya keeps morning meetings."),
    ).toBe(true);
  } finally {
    memory.close();
  }

  const again = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
    reflector,
  });
  try {
    expect(again.embeddingModel()).toBe("nomic-embed-text");
    expect(again.includeObservations()).toBe(true);
    expect(JSON.parse(readFileSync(memorySettingsFile(dir), "utf8"))).toEqual({
      embeddingModel: "nomic-embed-text",
      includeObservations: true,
      encryptionEnabled: false,
    });
    const listed = await again.observations();
    expect(listed.map((item) => item.text)).toContain(
      "Maya keeps morning meetings.",
    );
    expect(listed[0]?.derived).toBe(true);
    expect(listed[0]?.sourceFactIds?.length).toBe(2);
  } finally {
    again.close();
  }
});

test("idle reflect runs per agent bank and a down model writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-reflect-"));
  const alpha = new ChatMemory({
    dataDir: dir,
    agentId: "alpha",
    extractor: createFakeExtractor(() => []),
    reflector: createFakeReflector((input) => [
      {
        text: "Alpha keeps a morning routine.",
        confidence: 0.8,
        sourceFactIds: input.facts.slice(0, 2).map((fact) => fact.id),
      },
    ]),
  });
  const beta = new ChatMemory({
    dataDir: dir,
    agentId: "beta",
    extractor: createFakeExtractor(() => []),
    reflector: createFakeReflector(() => {
      throw new ReflectorUnavailableError(
        "Ollama is not reachable at 127.0.0.1:11434. reflect did not write anything.",
      );
    }),
  });
  try {
    await alpha.remember("Maya prefers morning meetings.");
    await alpha.remember("Maya writes the agenda the night before.");
    await beta.remember("Beta waters the office fern.");
    await beta.remember("Beta keeps the watering can by the fern.");

    alpha.noteActivity(1_000);
    expect(await alpha.reflectIfDue(1_000)).toBeNull();
    const reflected = await alpha.reflectIfDue(1_000 + 5 * 60 * 1000);
    expect(reflected?.map((item) => item.text)).toEqual([
      "Alpha keeps a morning routine.",
    ]);
    expect(await alpha.reflectIfDue(1_000 + 5 * 60 * 1000 + 1_000)).toBeNull();
    expect((await beta.observations()).map((item) => item.text)).toEqual([]);

    await expect(beta.reflect({ query: "fern" })).rejects.toThrow(
      /did not write anything/,
    );
    expect(
      beta
        .list()
        .map((fact) => fact.text)
        .sort(),
    ).toEqual([
      "Beta keeps the watering can by the fern.",
      "Beta waters the office fern.",
    ]);

    let runs = 0;
    const periodic = new ChatMemory({
      dataDir: mkdtempSync(join(tmpdir(), "pa-reflect-timer-")),
      extractor: createFakeExtractor(() => []),
      reflector: createFakeReflector((input) => {
        runs += 1;
        return [
          {
            text: "The timer saw both notes.",
            confidence: 0.7,
            sourceFactIds: input.facts.slice(0, 2).map((fact) => fact.id),
          },
        ];
      }),
    });
    try {
      await periodic.remember("Maya prefers morning meetings.");
      await periodic.remember("Maya writes the agenda the night before.");
      periodic.noteActivity(0);
      periodic.startIdleReflect({
        idleMs: 0,
        periodMs: 60_000,
        intervalMs: 20,
      });
      const started = Date.now();
      while (runs === 0 && Date.now() - started < 1_000) {
        await Bun.sleep(20);
      }
      expect(runs).toBeGreaterThan(0);
      periodic.stopIdleReflect();
      const seen = runs;
      await Bun.sleep(60);
      expect(runs).toBe(seen);
    } finally {
      periodic.close();
    }
  } finally {
    alpha.close();
    beta.close();
  }
});

test("the memory page can filter, edit, delete, and sweep junk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-cleanup-"));
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => [
      {
        text: "Maya prefers morning meetings.",
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Maya", type: "person" }],
      },
    ]),
  });
  const app = new DesktopApp({
    dataDir: dir,
    memory,
    adapter: silentAdapter(),
    probe: async () => "stopped",
  });
  await app.start();
  const methods = app.methods();
  try {
    await memory.remember("pepper is on the shelf");
    await memory.remember("unknown");
    await memory.retainExchange("Maya prefers morning meetings.", "saved");
    await memory.settle();

    const first = JSON.parse(
      await methods.memory_page({ limit: 2, offset: 0 }),
    ) as { facts: { id: string; text: string }[]; total: number };
    expect(first.facts).toHaveLength(2);
    expect(first.total).toBeGreaterThanOrEqual(3);
    const pepper = JSON.parse(
      await methods.memory_page({ limit: 20, query: "pepper" }),
    ) as { facts: { id: string; text: string }[] };
    expect(pepper.facts.map((fact) => fact.text)).toEqual([
      "pepper is on the shelf",
    ]);
    const maya = JSON.parse(
      await methods.memory_page({ limit: 20, entity: "Maya" }),
    ) as { facts: { text: string }[] };
    expect(maya.facts.map((fact) => fact.text)).toContain(
      "Maya prefers morning meetings.",
    );

    const edited = JSON.parse(
      await methods.memory_update({
        id: pepper.facts[0]?.id,
        text: "pepper is in the jar",
      }),
    ) as { text: string };
    expect(edited.text).toBe("pepper is in the jar");

    const preview = JSON.parse(
      await methods.memory_sweep({ dryRun: true }),
    ) as {
      dryRun: boolean;
      deleted: number;
      candidates: { text: string }[];
    };
    expect(preview.dryRun).toBe(true);
    expect(preview.deleted).toBe(0);
    expect(preview.candidates.map((item) => item.text)).toContain("unknown");
    expect(memory.list().map((fact) => fact.text)).toContain("unknown");

    const applied = JSON.parse(
      await methods.memory_sweep({ dryRun: false }),
    ) as { dryRun: boolean; deleted: number };
    expect(applied.dryRun).toBe(false);
    expect(applied.deleted).toBeGreaterThan(0);
    expect(memory.list().map((fact) => fact.text)).not.toContain("unknown");

    const ids = memory.list().map((fact) => fact.id);
    await methods.memory_delete_many({ ids });
    expect(memory.list()).toEqual([]);
  } finally {
    app.close();
  }
});

test("graph snapshot exposes recency and the four edge types", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-graph-"));
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => [
      {
        text: "Maya prefers morning meetings.",
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Maya", type: "person" }],
      },
      {
        text: "Maya writes the agenda the night before.",
        kind: "world",
        occurrenceTime: null,
        entities: [{ name: "Maya", type: "person" }],
      },
    ]),
    embed() {
      return [1, 0, 0];
    },
    reflector: createFakeReflector((input) => [
      {
        text: "Maya prepares for morning meetings.",
        confidence: 0.85,
        sourceFactIds: input.facts.slice(0, 2).map((fact) => fact.id),
      },
    ]),
  });
  try {
    await memory.retainExchange("Maya meetings and the agenda", "saved");
    await memory.settle();
    await memory.reflect({ query: "Maya" });
    const graph = await memory.graph();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(
      graph.nodes.every((node) => node.recency >= 0 && node.recency <= 1),
    ).toBe(true);
    const types = new Set(graph.edges.map((edge) => edge.type));
    expect(types.has("semantic")).toBe(true);
    expect(types.has("temporal")).toBe(true);
    expect(types.has("entity")).toBe(true);
    expect(types.has("derived")).toBe(true);
    const observation = graph.nodes.find((node) => node.derived);
    expect(observation).toBeTruthy();
    expect(graph.texts[observation?.id ?? ""]).toBe(
      "Maya prepares for morning meetings.",
    );
  } finally {
    memory.close();
  }
});

test("encryption migrates a plaintext bank, keeps a backup, and rejects a bad key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-encrypt-"));
  const sentence = "Maya's distinctive pepper jar sits on the shelf.";
  const key = randomKey();
  const wrong = randomKey();
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
  });
  try {
    await memory.remember(sentence);
    const encrypted = memory.encrypt(key);
    expect(encrypted.backup.endsWith(".bak")).toBe(true);
    expect(encrypted.fields).toBeGreaterThan(0);
    expect(readFileSync(encrypted.backup).includes(sentence)).toBe(true);
    expect(readFileSync(memory.file).includes(sentence)).toBe(false);
    expect(
      (await memory.recallFacts("pepper")).map((fact) => fact.text),
    ).toEqual([sentence]);
    expect(readFileSync(memorySettingsFile(dir), "utf8")).not.toContain(key);
    expect(() => memory.unlock(wrong)).toThrow(WRONG_KEY_MESSAGE);
  } finally {
    console.error = original;
    memory.close();
  }
  expect(logs.join("\n")).not.toContain(key);
  expect(logs.join("\n")).not.toContain(wrong);

  const missing = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
  });
  try {
    expect(() => missing.list()).toThrow(MISSING_KEY_MESSAGE);
    expect(await missing.recallFacts("pepper")).toEqual([]);
  } finally {
    missing.close();
  }

  const opened = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
    encryptionKey: key,
  });
  try {
    expect(opened.list().map((fact) => fact.text)).toEqual([sentence]);
  } finally {
    opened.close();
  }

  const mismatch = new ChatMemory({
    dataDir: dir,
    extractor: createFakeExtractor(() => []),
    encryptionKey: wrong,
  });
  try {
    expect(() => mismatch.list()).toThrow(WRONG_KEY_MESSAGE);
    expect(mismatch.status().error).toBe(WRONG_KEY_MESSAGE);
  } finally {
    mismatch.close();
  }
});

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

function silentAdapter(): ModelAdapter {
  return {
    async listModels() {
      return [];
    },
    async chat() {
      return { text: "ok" };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
}
