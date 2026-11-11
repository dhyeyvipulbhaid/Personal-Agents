import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals } from "../approvals/approvals.ts";
import type { ModelAdapter } from "../models/adapter.ts";
import {
  digestThreads,
  followUps,
  loadMailbox,
  markHandled,
  openMailState,
  recentThreads,
  sendStillNeedsApproval,
  writeReply,
} from "./mail.ts";
import { FOLLOW_UPS, MAIL_USER, sampleMessages, toEml } from "./sample.ts";

test("the sample mailbox lists sender, subject, date, and thread", () => {
  const folder = writeMailbox();
  const messages = loadMailbox(folder);

  expect(messages).toHaveLength(30);
  expect(messages.map((message) => message.from)).toContain(MAIL_USER);
  for (const message of messages) {
    expect(message.from.length).toBeGreaterThan(0);
    expect(message.subject.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(message.date))).toBe(false);
    expect(message.thread.length).toBeGreaterThan(0);
  }
  expect(new Set(messages.map((message) => message.thread)).size).toBe(8);
});

test("adding an eml shows it on the next refresh and sample files stay unchanged", () => {
  const folder = writeMailbox();
  const before = snapshot(folder);
  const first = loadMailbox(folder);
  expect(snapshot(folder)).toEqual(before);

  writeFileSync(
    join(folder, "extra.eml"),
    toEml({
      id: "<extra-1@example.com>",
      from: "a@example.com",
      to: MAIL_USER,
      date: "2026-11-11T11:00:00.000Z",
      subject: "Extra note",
      body: "new",
    }),
  );
  expect(loadMailbox(folder)).toHaveLength(first.length + 1);
  expect(snapshot(folder).filter((item) => item.name !== "extra.eml")).toEqual(
    before,
  );
});

test("follow-ups match the hand-checked list and handled threads leave it", () => {
  const messages = loadMailbox(writeMailbox());
  const db = openMailState(join(writeMailbox(), "state.sqlite"));
  expect(followUps(messages, db)).toEqual([...FOLLOW_UPS].sort());
  const first = followUps(messages, db)[0] ?? "";
  markHandled(db, first);
  expect(followUps(messages, db)).not.toContain(first);
  db.close();
});

test("the digest names every thread from the last 24 hours", async () => {
  const messages = loadMailbox(writeMailbox());
  expect(recentThreads(messages)).toEqual(
    ["Budget notes", "Desk request", "Lunch"].sort(),
  );
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    async chat(request) {
      return { text: request.messages[0]?.content ?? "" };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const summary = await digestThreads(messages, adapter, "llama");
  for (const name of ["Budget notes", "Desk request", "Lunch"]) {
    expect(summary).toContain(name);
  }
});

test("approving a draft writes one threaded eml and deny writes nothing", async () => {
  const outbox = join(tmpdir(), `pa-out-${Date.now()}`);
  const entries: { summary: string }[] = [];
  const approvals = new Approvals((entry) => entries.push(entry));
  const task = approvals.runTask("mail", async (ctx) => {
    const result = await ctx.request({
      summary: "reply North contract",
      draft: "first draft",
      capability: "mail.send",
      effects: ["sends"],
    });
    if (result.decision !== "approved") {
      return;
    }
    writeReply({
      outbox,
      originalId: "<north-4@example.com>",
      to: "a@example.com",
      subject: "Re: North contract",
      body: result.draft,
    });
  });
  const id = approvals.pending()[0]?.id ?? "";
  approvals.edit(id, "edited reply");
  approvals.approve(id);
  await task;
  const files = readdirSync(outbox);
  expect(files).toHaveLength(1);
  const text = readFileSync(join(outbox, files[0] ?? ""), "utf8");
  expect(text).toContain("In-Reply-To: <north-4@example.com>");
  expect(text).toContain("edited reply");
  expect(
    entries.some((entry) => entry.summary.toLowerCase().includes("approved")),
  ).toBe(true);

  const denied = join(tmpdir(), `pa-deny-${Date.now()}`);
  mkdirSync(denied);
  const deniedTask = approvals.runTask("mail-deny", async (ctx) => {
    const result = await ctx.request({
      summary: "reply again",
      draft: "no",
      capability: "mail.send",
      effects: ["sends"],
    });
    if (result.decision === "approved") {
      writeReply({
        outbox: denied,
        originalId: "<north-4@example.com>",
        to: "a@example.com",
        subject: "Re: North contract",
        body: result.draft,
      });
    }
  });
  approvals.deny(approvals.pending()[0]?.id ?? "");
  await deniedTask;
  expect(readdirSync(denied)).toEqual([]);
});

test("a granted send still waits and does not touch the network", () => {
  expect(sendStillNeedsApproval()).toBe("sends");
  const source = readFileSync(new URL("./mail.ts", import.meta.url), "utf8");
  expect(source.includes("fetch(")).toBe(false);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.reject(new Error("network"));
  }) as unknown as typeof fetch;
  try {
    const outbox = join(tmpdir(), `pa-net-${Date.now()}`);
    writeReply({
      outbox,
      originalId: "<north-4@example.com>",
      to: "a@example.com",
      subject: "Re: North contract",
      body: "local only",
    });
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a snoozed reply draft returns at its time", () => {
  let now = 1_000;
  const approvals = new Approvals(
    () => {},
    () => now,
  );
  void approvals.runTask("mail", async (ctx) => {
    await ctx.request({
      summary: "reply",
      draft: "later",
      capability: "mail.send",
      effects: ["sends"],
    });
  });
  const id = approvals.pending()[0]?.id ?? "";
  approvals.snooze(id, 5_000);
  expect(approvals.pending()).toEqual([]);
  now = 5_000;
  expect(approvals.pending()[0]?.draft).toBe("later");
});

test("the sample mailbox ships with the app", () => {
  const folder = join(import.meta.dir, "../../fixtures/mail");
  const names = readdirSync(folder).filter((name) => name.endsWith(".eml"));
  expect(names).toHaveLength(30);
  expect(loadMailbox(folder)).toHaveLength(30);
});

function writeMailbox(): string {
  const folder = join(
    tmpdir(),
    `pa-mail-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(folder);
  for (const message of sampleMessages()) {
    const name = `${message.id.replace(/[<>@]/g, "")}.eml`;
    writeFileSync(join(folder, name), toEml(message));
  }
  return folder;
}

function snapshot(folder: string): { name: string; text: string }[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith(".eml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(folder, name), "utf8") }));
}
