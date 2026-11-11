import { Database } from "bun:sqlite";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { decide } from "../broker/broker.ts";
import type { ModelAdapter } from "../models/adapter.ts";
import {
  DIGEST_THREADS,
  FOLLOW_UP_DAYS,
  MAIL_USER,
  SAMPLE_NOW,
} from "./sample.ts";

export type MailMessage = {
  id: string;
  inReplyTo: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  thread: string;
};

export type Mailbox = {
  messages: MailMessage[];
  followUps: string[];
  digestThreads: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseEml(text: string): Omit<MailMessage, "thread"> {
  const splitAt = text.search(/\r?\n\r?\n/);
  const head = splitAt === -1 ? text : text.slice(0, splitAt);
  const body =
    splitAt === -1 ? "" : text.slice(splitAt).replace(/^\r?\n\r?\n/, "");
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return {
    id: headers["message-id"] ?? "",
    inReplyTo: headers["in-reply-to"] ?? "",
    from: headers.from ?? "",
    to: headers.to ?? "",
    subject: headers.subject ?? "",
    date: new Date(headers.date ?? "").toISOString(),
    body: body.trim(),
  };
}

export function loadMailbox(folder: string): MailMessage[] {
  const messages = readdirSync(folder)
    .filter((name) => name.endsWith(".eml"))
    .map((name) => parseEml(readFileSync(join(folder, name), "utf8")));
  const byId = new Map(messages.map((message) => [message.id, message]));
  return messages
    .map((message) => ({ ...message, thread: rootSubject(message, byId) }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function openMailState(file: string): Database {
  const db = new Database(file);
  db.run(
    "CREATE TABLE IF NOT EXISTS mail_state (thread TEXT PRIMARY KEY, handled INTEGER NOT NULL)",
  );
  return db;
}

export function followUps(
  messages: MailMessage[],
  db: Database,
  now = SAMPLE_NOW,
  days = FOLLOW_UP_DAYS,
): string[] {
  const handled = new Set(
    (
      db.query("SELECT thread FROM mail_state WHERE handled = 1").all() as {
        thread: string;
      }[]
    ).map((row) => row.thread),
  );
  const cutoff = now - days * DAY_MS;
  const latest = new Map<string, MailMessage>();
  for (const message of messages) {
    const current = latest.get(message.thread);
    if (!current || message.date > current.date) {
      latest.set(message.thread, message);
    }
  }
  return [...latest.values()]
    .filter(
      (message) =>
        message.from !== MAIL_USER &&
        Date.parse(message.date) < cutoff &&
        !handled.has(message.thread),
    )
    .map((message) => message.thread)
    .sort();
}

export function markHandled(db: Database, thread: string): void {
  db.run(
    "INSERT INTO mail_state (thread, handled) VALUES (?, 1) ON CONFLICT(thread) DO UPDATE SET handled = 1",
    [thread],
  );
}

export function recentThreads(
  messages: MailMessage[],
  now = SAMPLE_NOW,
): string[] {
  const cutoff = now - DAY_MS;
  const names = new Set<string>();
  for (const message of messages) {
    if (Date.parse(message.date) >= cutoff) {
      names.add(message.thread);
    }
  }
  return [...names].sort();
}

export async function digestThreads(
  messages: MailMessage[],
  adapter: ModelAdapter,
  model: string,
  now = SAMPLE_NOW,
): Promise<string> {
  const names = recentThreads(messages, now);
  const result = await adapter.chat(
    {
      model,
      messages: [
        {
          role: "user",
          content: `Summarize these threads:\n${names.join("\n")}`,
        },
      ],
    },
    () => {},
  );
  return result.text;
}

export function expectedDigestThreads(): string[] {
  return [...DIGEST_THREADS].sort();
}

export function sendStillNeedsApproval(): string {
  const outcome = decide({
    pluginId: "mail",
    capability: "mail.send",
    scope: "outbox",
    effects: ["sends"],
    grants: [{ capability: "mail.send", scope: "*", decision: "always" }],
  });
  return outcome.reason;
}

/** Reply-all, leaving out this user's own address. */
export function replyRecipients(
  message: { from: string; to: string },
  self = MAIL_USER,
): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of `${message.from},${message.to}`.split(/[,;]/)) {
    const address = raw.trim();
    const key = address.toLowerCase();
    if (address.length === 0 || key === self.toLowerCase() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(address);
  }
  if (kept.length === 0) {
    throw new Error("There is nobody else to reply to on this message.");
  }
  return kept.join(", ");
}

export function writeReply(options: {
  outbox: string;
  originalId: string;
  to: string;
  subject: string;
  body: string;
}): string {
  mkdirSync(options.outbox, { recursive: true });
  const id = `<reply-${statSync(options.outbox).mtimeMs}@example.com>`;
  const file = join(
    options.outbox,
    `${Date.now()}-${Math.random().toString(16).slice(2)}.eml`,
  );
  const text = [
    `From: ${MAIL_USER}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    `In-Reply-To: ${options.originalId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body,
    "",
  ].join("\r\n");
  writeFileSync(file, text);
  return file;
}

function rootSubject(
  message: Omit<MailMessage, "thread">,
  byId: Map<string, Omit<MailMessage, "thread">>,
): string {
  let current = message;
  const seen = new Set<string>();
  while (
    current.inReplyTo &&
    byId.has(current.inReplyTo) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    current = byId.get(current.inReplyTo) ?? current;
  }
  return current.subject.replace(/^Re:\s*/, "");
}
