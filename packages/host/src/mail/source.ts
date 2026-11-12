import type { Approvals } from "../approvals/approvals.ts";
import {
  followUps,
  loadMailbox,
  type MailMessage,
  openMailState,
  recentThreads,
  writeReply,
} from "./mail.ts";
import {
  DEMO_FALLBACK,
  fallbackLine,
  type OutlookAdapter,
  OutlookError,
  type OutlookListedMessage,
  type OutlookStatus,
} from "./outlook.ts";
import { FOLLOW_UP_DAYS, MAIL_USER, SAMPLE_NOW } from "./sample.ts";

export type MailListItem = {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  thread: string;
  body: string;
  unread: boolean;
};

export type MailSnapshot = {
  source: "demo" | "outlook";
  status: string;
  needsConnect: boolean;
  account: string;
  count: number;
  followUps: string[];
  digest: string[];
  unread: string[];
  messages: MailListItem[];
};

export type MailCard = {
  summary: string;
  permissions: string[];
  needsConnect: boolean;
  connected: boolean;
  cause: string;
};

type ReplyInput = {
  message: MailListItem;
  to: string;
  subject: string;
  draft: string;
  source?: "demo" | "outlook";
};

const READ_SUMMARY =
  "Personal Agents wants to read mail in Outlook on this computer.";

export class LocalMail {
  private mode: "demo" | "outlook" = "demo";

  constructor(
    private readonly options: {
      mailDir: string;
      mailDb: string;
      outbox: string;
      outlook: OutlookAdapter;
      now: () => number;
    },
  ) {}

  async snapshot(): Promise<MailSnapshot> {
    const status = await this.options.outlook.detect();
    const granted = this.granted();
    if (status.state === "signed-in" && granted) {
      try {
        const listed = await this.options.outlook.list();
        this.mode = "outlook";
        return this.outlookSnapshot(listed, status);
      } catch (error) {
        this.mode = "demo";
        const detail =
          error instanceof OutlookError
            ? error.message
            : "Outlook did not answer.";
        return this.demoSnapshot(`${detail} ${DEMO_FALLBACK}.`, false);
      }
    }
    this.mode = "demo";
    return this.demoSnapshot(
      fallbackLine(status, granted),
      this.canConnect(status, granted),
    );
  }

  async describe(): Promise<MailCard> {
    const status = await this.options.outlook.detect();
    const granted = this.granted();
    const connected = status.state === "signed-in" && granted;
    if (connected) {
      return {
        summary: "Reads Outlook on this computer.",
        permissions: [
          "Reads mail in the Outlook app already signed in on this computer. No second login.",
          "Saving a draft and sending it each wait for your approval.",
        ],
        needsConnect: false,
        connected: true,
        cause: status.account || "signed in",
      };
    }
    return {
      summary: "Outlook not connected — using demo mailbox.",
      permissions: [
        fallbackLine(status, granted),
        "Sending a reply waits for your approval.",
      ],
      needsConnect: this.canConnect(status, granted),
      connected: false,
      cause: causeFor(status, granted),
    };
  }

  async detectFresh(): Promise<OutlookStatus> {
    return this.options.outlook.detect({ fresh: true });
  }

  granted(): boolean {
    const db = openMailState(this.options.mailDb);
    try {
      ensureGrant(db);
      const row = db
        .query("SELECT granted FROM outlook_grant WHERE id = 1")
        .get() as { granted: number } | null;
      return row?.granted === 1;
    } finally {
      db.close();
    }
  }

  grant(): void {
    const db = openMailState(this.options.mailDb);
    try {
      ensureGrant(db);
      db.run(
        "INSERT INTO outlook_grant (id, granted) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET granted = 1",
      );
    } finally {
      db.close();
    }
  }

  async read(id: string): Promise<string> {
    try {
      return (await this.options.outlook.read(id)).slice(0, 4_000);
    } catch {
      return "";
    }
  }

  requestRead(approvals: Approvals): {
    approvalId: string;
    task: Promise<void>;
  } {
    const task = approvals.runTask("mail", async (ctx) => {
      const result = await ctx.request({
        summary: READ_SUMMARY,
        draft: "",
        capability: "mail.read",
        effects: ["reads"],
      });
      if (result.decision === "approved") {
        this.grant();
      }
    });
    return { approvalId: approvals.pending().at(-1)?.id ?? "", task };
  }

  startReply(
    approvals: Approvals,
    input: ReplyInput,
    onPending?: (id: string) => void,
  ): { approvalId: string; task: Promise<void> } {
    const note = (id: string) => {
      if (id.length > 0) {
        onPending?.(id);
      }
    };
    const source = input.source ?? this.mode;
    const task = approvals.runTask("mail", async (ctx) => {
      if (source === "outlook") {
        const createdWait = ctx.request({
          summary: `Create a reply draft in Outlook: ${input.message.thread}`,
          draft: input.draft,
          capability: "mail.draft",
          effects: ["writes"],
        });
        note(approvals.pending().at(-1)?.id ?? "");
        const created = await createdWait;
        if (created.decision !== "approved") {
          return;
        }
        const saved = await this.options.outlook.createReplyDraft({
          originalId: input.message.id,
          to: input.to,
          subject: input.subject,
          body: created.draft,
        });
        const sendWait = ctx.request({
          summary: `Send the Outlook reply: ${input.message.thread}`,
          draft: created.draft,
          capability: "mail.send",
          effects: ["sends"],
        });
        note(approvals.pending().at(-1)?.id ?? "");
        const send = await sendWait;
        if (send.decision !== "approved") {
          return;
        }
        await this.options.outlook.sendDraft(saved.id);
        return;
      }
      const result = await ctx.request({
        summary: `Reply to ${input.message.thread}`,
        draft: input.draft,
        capability: "mail.send",
        effects: ["sends"],
      });
      if (result.decision !== "approved") {
        return;
      }
      writeReply({
        outbox: this.options.outbox,
        originalId: input.message.id,
        to: input.to,
        subject: input.subject,
        body: result.draft,
      });
    });
    const approvalId = approvals.pending().at(-1)?.id ?? "";
    note(approvalId);
    return { approvalId, task };
  }

  private outlookSnapshot(
    listed: OutlookListedMessage[],
    status: OutlookStatus,
  ): MailSnapshot {
    const all = listed.map(toMessage);
    const visible = all.filter((message) => message.folder !== "sent");
    const db = openMailState(this.options.mailDb);
    try {
      const self = status.account || MAIL_USER;
      const now = this.options.now();
      return {
        source: "outlook",
        status: fallbackLine(status, true),
        needsConnect: false,
        account: status.account,
        count: visible.length,
        followUps: followUps(all, db, now, FOLLOW_UP_DAYS, self),
        digest: recentThreads(all, now),
        unread: visible
          .filter(
            (message) => message.unread && !samePerson(message.from, self),
          )
          .map((message) => message.thread),
        messages: visible.map(publicItem),
      };
    } finally {
      db.close();
    }
  }

  private demoSnapshot(status: string, needsConnect: boolean): MailSnapshot {
    let messages: MailMessage[];
    try {
      messages = loadMailbox(this.options.mailDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unreadable";
      throw new Error(
        `The demo mailbox could not be read (${detail}). Messages live in ${this.options.mailDir}. Reopen the app to copy the sample mailbox again.`,
      );
    }
    const db = openMailState(this.options.mailDb);
    try {
      return {
        source: "demo",
        status,
        needsConnect,
        account: "",
        count: messages.length,
        followUps: followUps(messages, db, SAMPLE_NOW),
        digest: recentThreads(messages, SAMPLE_NOW),
        unread: [],
        messages: messages.map((message) => ({
          ...publicItem({ ...message, folder: "inbox", unread: false }),
        })),
      };
    } finally {
      db.close();
    }
  }

  private canConnect(status: OutlookStatus, granted: boolean): boolean {
    if (granted) {
      return false;
    }
    return status.state !== "missing" && status.state !== "new-outlook";
  }
}

function ensureGrant(db: ReturnType<typeof openMailState>): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS outlook_grant (id INTEGER PRIMARY KEY CHECK (id = 1), granted INTEGER NOT NULL)",
  );
}

function causeFor(status: OutlookStatus, granted: boolean): string {
  if (status.state === "signed-in" && !granted) {
    return "not connected";
  }
  if (status.reason === "script") {
    return "did not answer";
  }
  if (status.reason.length > 0) {
    return status.reason;
  }
  if (status.state === "missing") {
    return "not installed";
  }
  if (status.state === "not-running") {
    return "not running";
  }
  if (status.state === "signed-out") {
    return "not signed in";
  }
  if (status.state === "permission-denied") {
    return "automation blocked";
  }
  if (status.state === "new-outlook") {
    return "new outlook";
  }
  return "not connected";
}

type StoredMessage = MailMessage & {
  folder: "inbox" | "sent";
  unread: boolean;
};

function toMessage(item: OutlookListedMessage): StoredMessage {
  return {
    id: item.id,
    inReplyTo: "",
    from: item.from,
    to: item.to,
    subject: item.subject,
    date: item.date,
    body: item.preview,
    thread: threadName(item.subject),
    folder: item.folder,
    unread: item.unread,
  };
}

function publicItem(message: StoredMessage): MailListItem {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: message.date,
    thread: message.thread,
    body: message.body,
    unread: message.unread,
  };
}

function threadName(subject: string): string {
  let name = subject.trim();
  for (;;) {
    const next = name.replace(/^(re|fw|fwd)\s*:\s*/i, "").trim();
    if (next === name) {
      break;
    }
    name = next;
  }
  return name.length > 0 ? name : "(no subject)";
}

function samePerson(from: string, self: string): boolean {
  if (from === self) {
    return true;
  }
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase() === self.toLowerCase();
}
