import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals } from "../approvals/approvals.ts";
import { seedDemoData } from "../data/demo.ts";
import { DesktopApp } from "../desktop.ts";
import type { ModelAdapter } from "../models/adapter.ts";
import {
  createLocalOutlook,
  DEMO_FALLBACK,
  fallbackLine,
  MAC_SCRIPT,
  type OutlookAdapter,
  type OutlookOperation,
  type OutlookStatus,
  parseScriptOutput,
  statusFromProbe,
  WIN_SCRIPT,
} from "./outlook.ts";
import { LocalMail } from "./source.ts";

const signedIn: OutlookStatus = {
  state: "signed-in",
  platform: "mac",
  account: "ada@contoso.com",
  reason: "",
};

test("a signed-in Outlook is detected from the local app", async () => {
  const calls: OutlookOperation[] = [];
  const outlook = createLocalOutlook({
    platform: "mac",
    appExists: () => true,
    processRunning: () => true,
    newOutlook: () => false,
    run: async (operation) => {
      calls.push(operation);
      return JSON.stringify({
        ok: true,
        state: "signed-in",
        account: "ada@contoso.com",
      });
    },
  });
  const status = await outlook.detect({ fresh: true });
  expect(status.state).toBe("signed-in");
  expect(status.account).toBe("ada@contoso.com");
  expect(status.platform).toBe("mac");
  expect(calls).toEqual(["detect"]);
});

test("a missing or quit Outlook falls back without launching it", async () => {
  let calls = 0;
  const missing = createLocalOutlook({
    platform: "mac",
    appExists: () => false,
    processRunning: () => false,
    newOutlook: () => false,
    run: async () => {
      calls += 1;
      return "";
    },
  });
  const quit = createLocalOutlook({
    platform: "windows",
    appExists: () => true,
    processRunning: () => false,
    newOutlook: () => false,
    run: async () => {
      calls += 1;
      return "";
    },
  });
  const other = createLocalOutlook({
    platform: "other",
    run: async () => {
      calls += 1;
      return "";
    },
  });
  expect((await missing.detect({ fresh: true })).state).toBe("missing");
  expect((await quit.detect({ fresh: true })).state).toBe("not-running");
  expect((await other.detect({ fresh: true })).state).toBe("missing");
  expect(calls).toBe(0);
  expect(fallbackLine(await missing.detect({ fresh: true }), false)).toContain(
    DEMO_FALLBACK,
  );
});

test("New Outlook and a denied Automation prompt are named and do not list mail", () => {
  const fresh = statusFromProbe({
    platform: "mac",
    appExists: true,
    running: true,
    newOutlook: false,
    report: { ok: false, code: "no-script" },
  });
  const blocked = statusFromProbe({
    platform: "mac",
    appExists: true,
    running: true,
    newOutlook: false,
    report: { ok: false, code: "permission" },
  });
  const windowsNew = statusFromProbe({
    platform: "windows",
    appExists: false,
    running: false,
    newOutlook: true,
    report: null,
  });
  expect(fresh.state).toBe("new-outlook");
  expect(blocked.state).toBe("permission-denied");
  expect(windowsNew.state).toBe("new-outlook");
  expect(fallbackLine(blocked, false)).toContain("Automation");
  expect(fallbackLine(fresh, false)).toContain("New Outlook");
  expect(fallbackLine(blocked, false)).toContain(DEMO_FALLBACK);
  expect(fallbackLine(blocked, false).toLowerCase()).not.toContain(
    "unavailable",
  );
});

test("inbox messages keep subject, sender, date, preview, and unread", () => {
  const report = parseScriptOutput(
    `noise\n${JSON.stringify({
      ok: true,
      messages: [
        {
          id: "m-1",
          from: "Sam <sam@contoso.com>",
          to: "ada@contoso.com",
          subject: "Re: Budget notes",
          date: "2026-11-11T15:00:00.000Z",
          preview: "Need the signed copy today.",
          unread: true,
          folder: "inbox",
        },
        {
          id: "bad",
          from: "x@contoso.com",
          subject: "Skip",
          date: "not-a-date",
          preview: "nope",
          unread: false,
          folder: "inbox",
        },
      ],
    })}`,
  );
  expect(report?.messages).toHaveLength(1);
  const message = report?.messages?.[0];
  expect(message?.subject).toBe("Re: Budget notes");
  expect(message?.from).toBe("Sam <sam@contoso.com>");
  expect(message?.date).toBe("2026-11-11T15:00:00.000Z");
  expect(message?.preview).toBe("Need the signed copy today.");
  expect(message?.unread).toBe(true);
});

test("permission denied uses the demo mailbox and does not read Outlook", async () => {
  let listed = 0;
  const mail = mailbox({
    async detect() {
      return {
        state: "permission-denied",
        platform: "mac",
        account: "",
        reason: "automation blocked",
      };
    },
    async list() {
      listed += 1;
      return [];
    },
    async read() {
      return "";
    },
    async createReplyDraft() {
      throw new Error("should not draft");
    },
    async sendDraft() {
      throw new Error("should not send");
    },
  });
  const snap = await mail.snapshot();
  expect(snap.source).toBe("demo");
  expect(snap.count).toBe(30);
  expect(snap.needsConnect).toBe(false);
  expect(snap.status).toContain(DEMO_FALLBACK);
  expect(snap.status).toContain("Automation");
  expect(listed).toBe(0);
});

test("Outlook is not read until the connect approval is granted", async () => {
  let listed = 0;
  const messages = [sampleOutlook()];
  const mail = mailbox({
    async detect() {
      return signedIn;
    },
    async list() {
      listed += 1;
      return messages;
    },
    async read() {
      return "";
    },
    async createReplyDraft() {
      return { id: "draft-1" };
    },
    async sendDraft() {},
  });
  const before = await mail.snapshot();
  expect(before.source).toBe("demo");
  expect(before.needsConnect).toBe(true);
  expect(before.status).toContain(DEMO_FALLBACK);
  expect(listed).toBe(0);

  const approvals = new Approvals(() => {});
  const connect = mail.requestRead(approvals);
  expect(approvals.pending()[0]?.summary).toBe(
    "Personal Agents wants to read mail in Outlook on this computer.",
  );
  expect(listed).toBe(0);
  approvals.deny(connect.approvalId);
  await connect.task;
  expect((await mail.snapshot()).source).toBe("demo");

  const again = mail.requestRead(approvals);
  approvals.approve(again.approvalId);
  await again.task;
  const after = await mail.snapshot();
  expect(after.source).toBe("outlook");
  expect(after.account).toBe("ada@contoso.com");
  expect(after.messages.map((item) => item.subject)).toEqual(["Budget notes"]);
  expect(after.messages[0]?.unread).toBe(true);
  expect(after.messages[0]?.body).toBe("Need the signed copy today.");
  expect(listed).toBe(1);
});

test("a reply draft is saved only after approval and send waits for a second approval", async () => {
  const drafts: { body: string; to: string }[] = [];
  const sent: string[] = [];
  const mail = grantedMail({
    async createReplyDraft(input) {
      drafts.push({ body: input.body, to: input.to });
      return { id: "draft-9" };
    },
    async sendDraft(id) {
      sent.push(id);
    },
  });
  const snap = await mail.snapshot();
  const message = snap.messages[0];
  if (!message) {
    throw new Error("missing outlook message");
  }
  const approvals = new Approvals(() => {});
  const reply = mail.startReply(approvals, {
    message,
    to: "sam@contoso.com",
    subject: "Re: Budget notes",
    draft: "first draft",
  });
  expect(drafts).toEqual([]);
  expect(sent).toEqual([]);
  expect(approvals.pending()[0]?.capability).toBe("mail.draft");
  approvals.edit(reply.approvalId, "edited reply");
  approvals.approve(reply.approvalId);
  await waitFor(() =>
    approvals.pending().some((item) => item.capability === "mail.send"),
  );
  expect(drafts).toEqual([{ body: "edited reply", to: "sam@contoso.com" }]);
  expect(sent).toEqual([]);
  const sendId =
    approvals.pending().find((item) => item.capability === "mail.send")?.id ??
    "";
  approvals.approve(sendId);
  await reply.task;
  expect(sent).toEqual(["draft-9"]);
});

test("denying a draft or a send does not send and does not ask the model again", async () => {
  let drafts = 0;
  let sent = 0;
  let models = 0;
  const outlook = grantedAdapter({
    async createReplyDraft() {
      drafts += 1;
      return { id: "draft-2" };
    },
    async sendDraft() {
      sent += 1;
    },
  });
  const { app, methods } = await desktop(outlook, async () => {
    models += 1;
    return { text: "Thanks for the note." };
  });
  try {
    const snap = JSON.parse(await methods.mail_state({})) as {
      messages: { id: string }[];
    };
    const denied = JSON.parse(
      await methods.mail_draft({ id: snap.messages[0]?.id ?? "" }),
    ) as { approvalId: string };
    expect(models).toBe(1);
    await methods.approval_act({
      action: "deny",
      id: denied.approvalId,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    expect(drafts).toBe(0);
    expect(sent).toBe(0);
    expect(models).toBe(1);

    const second = JSON.parse(
      await methods.mail_draft({ id: snap.messages[0]?.id ?? "" }),
    ) as { approvalId: string };
    await methods.approval_act({
      action: "approve",
      id: second.approvalId,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    await waitFor(async () => {
      const pending = JSON.parse(await methods.approvals({})) as {
        capability: string;
        id: string;
      }[];
      return pending.some((item) => item.capability === "mail.send");
    });
    const pending = JSON.parse(await methods.approvals({})) as {
      capability: string;
      id: string;
    }[];
    const send = pending.find((item) => item.capability === "mail.send");
    await methods.approval_act({
      action: "deny",
      id: send?.id ?? "",
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    expect(drafts).toBe(1);
    expect(sent).toBe(0);
    expect(models).toBe(2);
  } finally {
    app.close();
  }
});

test("a snoozed Outlook draft comes back and still has not been saved", async () => {
  let drafts = 0;
  const mail = grantedMail({
    async createReplyDraft() {
      drafts += 1;
      return { id: "draft-3" };
    },
    async sendDraft() {},
  });
  const message = (await mail.snapshot()).messages[0];
  if (!message) {
    throw new Error("missing outlook message");
  }
  let now = 1_000;
  const approvals = new Approvals(
    () => {},
    () => now,
  );
  const reply = mail.startReply(approvals, {
    message,
    to: "sam@contoso.com",
    subject: "Re: Budget notes",
    draft: "later",
  });
  approvals.snooze(reply.approvalId, 5_000);
  expect(approvals.pending()).toEqual([]);
  expect(drafts).toBe(0);
  now = 5_000;
  expect(approvals.pending()[0]?.draft).toBe("later");
  expect(approvals.pending()[0]?.capability).toBe("mail.draft");
});

test("the Outlook scripts stay on this computer", () => {
  for (const script of [MAC_SCRIPT, WIN_SCRIPT]) {
    const lower = script.toLowerCase();
    expect(lower).not.toContain("graph.microsoft");
    expect(lower).not.toContain("http");
    expect(lower).not.toContain("token");
    expect(lower).not.toContain("password");
    expect(script).not.toContain("fetch(");
  }
  const winDraft = WIN_SCRIPT.split("OP_DRAFT")[1]?.split("OP_SEND")[0] ?? "";
  expect(winDraft).toContain(".Save(");
  expect(winDraft.toLowerCase()).not.toContain(".send(");
  const winSend = WIN_SCRIPT.split("OP_SEND")[1] ?? "";
  expect(winSend).toContain(".Send(");
  const macDraft = MAC_SCRIPT.split("OP_DRAFT")[1]?.split("OP_SEND")[0] ?? "";
  expect(macDraft).not.toContain(".send(");
  expect(MAC_SCRIPT.split("OP_SEND")[1] ?? "").toContain(".send(");
});

test("listing mail does not write the message text to the console", async () => {
  const lines: string[] = [];
  const original = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const outlook = createLocalOutlook({
      platform: "mac",
      appExists: () => true,
      processRunning: () => true,
      newOutlook: () => false,
      run: async (operation) => {
        if (operation === "detect") {
          return JSON.stringify({
            ok: true,
            state: "signed-in",
            account: "ada@contoso.com",
          });
        }
        return JSON.stringify({
          ok: true,
          messages: [sampleOutlook()],
        });
      },
    });
    await outlook.detect({ fresh: true });
    const messages = await outlook.list();
    expect(messages[0]?.preview).toBe("Need the signed copy today.");
    expect(lines.join("\n")).not.toContain("Need the signed copy today.");
  } finally {
    console.log = original;
    console.error = error;
  }
});

function sampleOutlook() {
  return {
    id: "m-1",
    from: "Sam <sam@contoso.com>",
    to: "ada@contoso.com",
    subject: "Budget notes",
    date: "2026-11-11T15:00:00.000Z",
    preview: "Need the signed copy today.",
    unread: true,
    folder: "inbox" as const,
  };
}

function mailbox(outlook: OutlookAdapter, root = tempRoot()): LocalMail {
  const paths = seedDemoData(root);
  return new LocalMail({
    mailDir: paths.mailDir,
    mailDb: paths.mailDb,
    outbox: join(root, "outbox"),
    outlook,
    now: () => Date.parse("2026-11-11T18:00:00.000Z"),
  });
}

function grantedMail(
  extra: Pick<OutlookAdapter, "createReplyDraft" | "sendDraft">,
): LocalMail {
  const mail = mailbox(grantedAdapter(extra));
  mail.grant();
  return mail;
}

function grantedAdapter(
  extra: Pick<OutlookAdapter, "createReplyDraft" | "sendDraft">,
): OutlookAdapter {
  return {
    async detect() {
      return signedIn;
    },
    async list() {
      return [sampleOutlook()];
    },
    async read() {
      return "";
    },
    ...extra,
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pa-outlook-"));
}

async function desktop(
  outlook: OutlookAdapter,
  chat: ModelAdapter["chat"],
): Promise<{
  app: DesktopApp;
  methods: ReturnType<DesktopApp["methods"]>;
}> {
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    chat,
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const app = new DesktopApp({
    dataDir: tempRoot(),
    adapter,
    outlook,
    probe: async () => "running",
    now: () => Date.parse("2026-11-11T18:00:00.000Z"),
  });
  await app.start();
  const methods = app.methods();
  await methods.mail_connect({});
  const pending = JSON.parse(await methods.approvals({})) as { id: string }[];
  await methods.approval_act({
    action: "approve",
    id: pending[0]?.id ?? "",
    draft: "",
    instruction: "",
    scope: "once",
    until: 0,
  });
  return { app, methods };
}

async function waitFor(ready: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (await ready()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for Outlook approval");
}
