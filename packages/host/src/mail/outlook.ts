import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEMO_FALLBACK = "Outlook not connected — using demo mailbox";

export type OutlookState =
  | "signed-in"
  | "missing"
  | "not-running"
  | "signed-out"
  | "permission-denied"
  | "new-outlook";

export type OutlookPlatform = "mac" | "windows" | "other";

export type OutlookStatus = {
  state: OutlookState;
  platform: OutlookPlatform;
  account: string;
  reason: string;
};

export type OutlookListedMessage = {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  preview: string;
  unread: boolean;
  folder: "inbox" | "sent";
};

export type OutlookDraftInput = {
  originalId: string;
  to: string;
  subject: string;
  body: string;
};

export type OutlookOperation = "detect" | "list" | "draft" | "send" | "read";

export type OutlookAdapter = {
  detect(options?: { fresh?: boolean }): Promise<OutlookStatus>;
  list(): Promise<OutlookListedMessage[]>;
  read(id: string): Promise<string>;
  createReplyDraft(input: OutlookDraftInput): Promise<{ id: string }>;
  sendDraft(id: string): Promise<void>;
};

export type ScriptReport = {
  ok: boolean;
  state?: string;
  account?: string;
  code?: string;
  id?: string;
  body?: string;
  inbox?: boolean;
  messages?: OutlookListedMessage[];
};

type ProbeInput = {
  platform: OutlookPlatform;
  appExists: boolean;
  running: boolean;
  newOutlook: boolean;
  report: ScriptReport | null;
};

export type OutlookHost = {
  platform?: OutlookPlatform;
  appExists?: () => boolean;
  processRunning?: () => boolean;
  newOutlook?: () => boolean;
  run?: (
    operation: OutlookOperation,
    payload: Record<string, string>,
  ) => Promise<string>;
};

export class OutlookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlookError";
  }
}

/** The phrase Mail and Capabilities show when Outlook is not the source. */
export function fallbackLine(status: OutlookStatus, granted: boolean): string {
  if (status.state === "signed-in" && granted) {
    return status.account.length > 0
      ? `Outlook connected (${status.account}).`
      : "Outlook connected on this computer.";
  }
  if (status.state === "permission-denied") {
    const why =
      status.platform === "windows"
        ? "Windows blocked Outlook automation for this account."
        : "macOS blocked Automation for Outlook. Allow Personal Agents in System Settings → Privacy & Security → Automation.";
    return `${why} ${DEMO_FALLBACK}.`;
  }
  if (status.state === "new-outlook") {
    return `New Outlook has no usable scripting. Open classic Outlook, or keep the demo mailbox. ${DEMO_FALLBACK}.`;
  }
  if (status.state === "signed-out") {
    return `Outlook is not signed in. ${DEMO_FALLBACK}.`;
  }
  if (status.state === "not-running") {
    const why =
      status.reason === "script"
        ? "Outlook did not answer."
        : "Outlook is not running.";
    return `${why} ${DEMO_FALLBACK}.`;
  }
  if (status.state === "signed-in") {
    return `Outlook is signed in on this computer. Connect to read it. ${DEMO_FALLBACK}.`;
  }
  return `Outlook is not installed. ${DEMO_FALLBACK}.`;
}

/** Why Connect cannot finish yet. Null when the read approval may be raised. */
export function connectFailure(status: OutlookStatus): string | null {
  if (status.state === "signed-in") {
    return null;
  }
  if (status.state === "not-running" && status.reason === "script") {
    return "Outlook did not answer. Leave it open and click Connect again.";
  }
  if (status.state === "not-running") {
    return "Open Outlook, sign in, leave it running, then click Connect again.";
  }
  if (status.state === "permission-denied") {
    return status.platform === "windows"
      ? "Windows blocked Outlook automation. Allow it for this account, then click Connect again."
      : "macOS blocked Automation for Outlook. Allow Personal Agents in System Settings → Privacy & Security → Automation, then click Connect again.";
  }
  if (status.state === "signed-out") {
    return "Sign in to Outlook on this computer, then click Connect again.";
  }
  return fallbackLine(status, false);
}

export function statusFromProbe(input: ProbeInput): OutlookStatus {
  const base = {
    platform: input.platform,
    account: "",
  };
  if (input.platform === "other") {
    return { ...base, state: "missing", reason: "not installed" };
  }
  if (input.newOutlook && !input.running) {
    return { ...base, state: "new-outlook", reason: "new outlook" };
  }
  if (!input.running && !input.appExists) {
    return { ...base, state: "missing", reason: "not installed" };
  }
  if (!input.running) {
    return { ...base, state: "not-running", reason: "not running" };
  }
  const report = input.report;
  if (!report || report.ok === false) {
    if (report?.code === "permission") {
      return {
        ...base,
        state: "permission-denied",
        reason: "automation blocked",
      };
    }
    if (report?.code === "no-script") {
      return { ...base, state: "new-outlook", reason: "new outlook" };
    }
    return { ...base, state: "not-running", reason: "script" };
  }
  const account =
    typeof report.account === "string" ? report.account.trim() : "";
  const accountOk = account.includes("@");
  if (report.state === "signed-in" && (accountOk || report.inbox === true)) {
    return {
      ...base,
      state: "signed-in",
      account: accountOk ? account : "",
      reason: "",
    };
  }
  if (report.state === "not-running") {
    return { ...base, state: "not-running", reason: "not running" };
  }
  return { ...base, state: "signed-out", reason: "not signed in" };
}

export function parseScriptOutput(stdout: string): ScriptReport | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryJson(lines[index] ?? "");
    if (parsed) {
      return cleanReport(parsed);
    }
  }
  return null;
}

export function createLocalOutlook(host: OutlookHost = {}): OutlookAdapter {
  const platform = host.platform ?? platformOf(process.platform);
  const appExists = host.appExists ?? (() => defaultAppExists(platform));
  const processRunning =
    host.processRunning ?? (() => defaultRunning(platform));
  const newOutlook = host.newOutlook ?? (() => defaultNewOutlook(platform));
  const run =
    host.run ??
    ((operation, payload) => defaultRun(platform, operation, payload));
  let cached: { at: number; status: OutlookStatus } | null = null;

  async function probe(): Promise<OutlookStatus> {
    const running = processRunning();
    const exists = appExists();
    const newer = newOutlook();
    if (platform === "other" || (newer && !running) || !running) {
      return statusFromProbe({
        platform,
        appExists: exists,
        running,
        newOutlook: newer,
        report: null,
      });
    }
    const stdout = await run("detect", {});
    return statusFromProbe({
      platform,
      appExists: exists,
      running,
      newOutlook: newer,
      report: parseScriptOutput(stdout),
    });
  }

  return {
    async detect(options) {
      const now = Date.now();
      if (!options?.fresh && cached && now - cached.at < 4_000) {
        return cached.status;
      }
      const status = await probe();
      cached = { at: now, status };
      return status;
    },
    async list() {
      const report = await runReport("list", {}, run);
      return report.messages ?? [];
    },
    async read(id) {
      const report = await runReport("read", { id }, run);
      return typeof report.body === "string" ? report.body.slice(0, 4_000) : "";
    },
    async createReplyDraft(input) {
      const report = await runReport(
        "draft",
        {
          originalId: input.originalId,
          to: input.to,
          subject: input.subject,
          body: input.body,
        },
        run,
      );
      if (!report.id) {
        throw new OutlookError("Outlook could not save the draft.");
      }
      return { id: report.id };
    },
    async sendDraft(id) {
      await runReport("send", { id }, run);
    },
  };
}

async function runReport(
  operation: OutlookOperation,
  payload: Record<string, string>,
  run: NonNullable<OutlookHost["run"]>,
): Promise<ScriptReport> {
  const report = parseScriptOutput(await run(operation, payload));
  if (!report?.ok) {
    throw new OutlookError(fixedFailure(report?.code));
  }
  return report;
}

function fixedFailure(code: string | undefined): string {
  if (code === "permission") {
    return "macOS blocked Automation for Outlook.";
  }
  if (code === "no-script") {
    return "New Outlook has no usable scripting.";
  }
  if (code === "missing-draft") {
    return "That draft is not in Outlook.";
  }
  return "Outlook could not finish the mail action.";
}

function tryJson(line: string): Record<string, unknown> | null {
  const candidates = [line];
  if (line.startsWith('"') && line.endsWith('"')) {
    try {
      const unquoted = JSON.parse(line) as unknown;
      if (typeof unquoted === "string") {
        candidates.push(unquoted);
      }
    } catch {
      // The line is not a quoted JSON string.
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function cleanReport(value: Record<string, unknown>): ScriptReport {
  const rawMessages = Array.isArray(value.messages)
    ? value.messages
    : value.messages && typeof value.messages === "object"
      ? [value.messages]
      : undefined;
  const messages = rawMessages?.flatMap((item) => {
    const message = cleanMessage(item);
    return message ? [message] : [];
  });
  return {
    ok: value.ok === true,
    state: typeof value.state === "string" ? value.state : undefined,
    account: typeof value.account === "string" ? value.account : undefined,
    code: typeof value.code === "string" ? value.code : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
    body:
      typeof value.body === "string" ? value.body.slice(0, 4_000) : undefined,
    inbox: value.inbox === true,
    messages,
  };
}

function cleanMessage(value: unknown): OutlookListedMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Record<string, unknown>;
  const id = text(item.id);
  const subject = text(item.subject);
  const parsed = new Date(text(item.date));
  if (
    id.length === 0 ||
    subject.length === 0 ||
    Number.isNaN(parsed.getTime())
  ) {
    return null;
  }
  return {
    id,
    from: text(item.from),
    to: text(item.to),
    subject,
    date: parsed.toISOString(),
    preview: text(item.preview).replace(/\s+/g, " ").trim().slice(0, 240),
    unread: item.unread === true,
    folder: item.folder === "sent" ? "sent" : "inbox",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function platformOf(platform: NodeJS.Platform): OutlookPlatform {
  if (platform === "darwin") {
    return "mac";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "other";
}

function defaultAppExists(platform: OutlookPlatform): boolean {
  if (platform === "mac") {
    return (
      existsSync("/Applications/Microsoft Outlook.app") ||
      existsSync(join(homedir(), "Applications", "Microsoft Outlook.app"))
    );
  }
  if (platform === "windows") {
    return classicOutlookInstalled();
  }
  return false;
}

function defaultRunning(platform: OutlookPlatform): boolean {
  if (platform === "mac") {
    return commandOk("/usr/bin/pgrep", ["-x", "Microsoft Outlook"]);
  }
  if (platform === "windows") {
    return imageRunning("OUTLOOK.EXE");
  }
  return false;
}

function defaultNewOutlook(platform: OutlookPlatform): boolean {
  if (platform !== "windows") {
    return false;
  }
  if (classicOutlookInstalled() || imageRunning("OUTLOOK.EXE")) {
    return false;
  }
  return newOutlookPresent();
}

function classicOutlookInstalled(): boolean {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const tails = [
    "Microsoft Office\\root\\Office16\\OUTLOOK.EXE",
    "Microsoft Office\\Office16\\OUTLOOK.EXE",
  ];
  return roots.some((root) =>
    tails.some((tail) => existsSync(join(root, tail))),
  );
}

function newOutlookPresent(): boolean {
  const local = process.env.LOCALAPPDATA;
  if (!local) {
    return false;
  }
  return (
    existsSync(join(local, "Microsoft", "WindowsApps", "olk.exe")) ||
    imageRunning("olk.exe")
  );
}

function imageRunning(image: string): boolean {
  const result = spawnSync(
    "tasklist",
    ["/FI", `IMAGENAME eq ${image}`, "/NH"],
    { encoding: "utf8", timeout: 3_000, windowsHide: true },
  );
  return (result.stdout ?? "").toLowerCase().includes(image.toLowerCase());
}

function commandOk(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 1_500 });
  return result.status === 0;
}

async function defaultRun(
  platform: OutlookPlatform,
  operation: OutlookOperation,
  payload: Record<string, string>,
): Promise<string> {
  if (platform === "other") {
    return "";
  }
  const env = {
    ...process.env,
    PA_OUTLOOK_OP: operation,
    PA_OUTLOOK_PAYLOAD: Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64",
    ),
  };
  try {
    const result =
      platform === "mac"
        ? spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-"], {
            input: MAC_SCRIPT,
            encoding: "utf8",
            timeout: 20_000,
            env,
          })
        : spawnSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", "-"],
            {
              input: WIN_SCRIPT,
              encoding: "utf8",
              timeout: 20_000,
              windowsHide: true,
              env,
            },
          );
    const stdout = result.stdout ?? "";
    if (parseScriptOutput(stdout)) {
      return stdout;
    }
    const stderr = (result.stderr ?? "").toLowerCase();
    if (stderr.includes("not authorized") || stderr.includes("-1743")) {
      return JSON.stringify({ ok: false, code: "permission" });
    }
    if (
      stderr.includes("doesn't understand") ||
      stderr.includes("-1728") ||
      stderr.includes("-1708")
    ) {
      return JSON.stringify({ ok: false, code: "no-script" });
    }
    return stdout;
  } catch {
    return "";
  }
}

export const MAC_SCRIPT = `function run() {
  ObjC.import("Foundation");
  try {
    return JSON.stringify(main());
  } catch (error) {
    var message = String(error);
    var code = "script";
    if (/not authorized|-1743/i.test(message)) code = "permission";
    else if (/doesn't understand|Can't get|not defined|-1708|-1728/i.test(message)) code = "no-script";
    return JSON.stringify({ ok: false, code: code });
  }
}

function main() {
  var op = envValue("PA_OUTLOOK_OP");
  var outlook = Application("Microsoft Outlook");
  if (op === "detect") return detectAccount(outlook);
  if (op === "list") return { ok: true, messages: listMail(outlook) };
  var payload = readPayload();
  // OP_DRAFT
  if (op === "draft") {
    var id = createDraft(outlook, payload);
    if (!id) return { ok: false, code: "draft-failed" };
    return { ok: true, id: id };
  }
  // OP_SEND
  if (op === "send") {
    sendSaved(outlook, payload);
    return { ok: true };
  }
  if (op === "read") return { ok: true, body: readBody(outlook, payload) };
  return { ok: false, code: "script" };
}

function envValue(name) {
  try {
    var raw = $.NSProcessInfo.processInfo.environment.objectForKey(name);
    var value = ObjC.unwrap(raw);
    return value ? String(value) : "";
  } catch (error) {
    return "";
  }
}

function readPayload() {
  var encoded = envValue("PA_OUTLOOK_PAYLOAD");
  if (!encoded) return {};
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
  if (!data) return {};
  var text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  if (!text) return {};
  return JSON.parse(String(text));
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    if (typeof value === "function") return textOf(value());
  } catch (error) {}
  try {
    var unwrapped = ObjC.unwrap(value);
    if (typeof unwrapped === "string") return unwrapped;
  } catch (error) {}
  return String(value);
}

function addressOf(recipient) {
  if (recipient == null) return "";
  if (typeof recipient === "string") return recipient;
  try {
    var email = recipient.emailAddress;
    email = typeof email === "function" ? email.call(recipient) : email;
    if (typeof email === "string" && email.indexOf("@") !== -1) return email;
    if (email) {
      var inner = email.address;
      inner = typeof inner === "function" ? inner.call(email) : inner;
      var fromInner = textOf(inner);
      if (fromInner.indexOf("@") !== -1) return fromInner;
      var fromEmail = textOf(email);
      if (fromEmail.indexOf("@") !== -1) return fromEmail;
    }
  } catch (error) {}
  try {
    var direct = recipient.address;
    direct = typeof direct === "function" ? direct.call(recipient) : direct;
    var plain = textOf(direct);
    if (plain.indexOf("@") !== -1) return plain;
  } catch (error) {}
  return "";
}

function firstAccountEmail(outlook) {
  try {
    var primary = addressOf(outlook.defaultAccount());
    if (primary.indexOf("@") !== -1) return primary;
  } catch (error) {}
  var lists = ["exchangeAccounts", "imapAccounts", "popAccounts", "accounts"];
  for (var i = 0; i < lists.length; i++) {
    try {
      var group = outlook[lists[i]]();
      var count = group && group.length ? group.length : 0;
      for (var n = 0; n < count; n++) {
        var email = addressOf(group[n]);
        if (email.indexOf("@") !== -1) return email;
      }
    } catch (error) {}
  }
  return "";
}

function detectAccount(outlook) {
  var account = firstAccountEmail(outlook);
  var inbox = false;
  try {
    var count = outlook.inbox().messages().length;
    inbox = typeof count === "number";
  } catch (error) {}
  if (account.indexOf("@") !== -1 || inbox) {
    return { ok: true, state: "signed-in", account: account.indexOf("@") === -1 ? "" : account, inbox: inbox };
  }
  return { ok: true, state: "signed-out", account: "", inbox: false };
}

function preview(value) {
  return String(value || "").replace(/\\s+/g, " ").trim().slice(0, 240);
}

function stamp(message, folder) {
  try {
    var when = folder === "sent" ? message.timeSent() : message.timeReceived();
    var parsed = new Date(when);
    return parsed.getTime();
  } catch (error) {
    return 0;
  }
}

function mapMessage(message, folder) {
  var from = "";
  try { from = addressOf(message.sender()); } catch (error) {}
  var to = "";
  try {
    var people = message.toRecipients();
    var parts = [];
    var limit = Math.min(people.length, 5);
    for (var i = 0; i < limit; i++) {
      var addr = addressOf(people[i]);
      if (addr) parts.push(addr);
    }
    to = parts.join(", ");
  } catch (error) {}
  var date = "";
  var millis = stamp(message, folder);
  if (millis > 0) date = new Date(millis).toISOString();
  var unread = false;
  try { unread = message.isRead() === false; } catch (error) {}
  return {
    id: String(message.id()),
    from: from,
    to: to,
    subject: String(message.subject() || ""),
    date: date,
    preview: preview(message.content()),
    unread: unread,
    folder: folder
  };
}

function newerAtEnd(messages) {
  if (!messages || messages.length < 2) return false;
  return stamp(messages[messages.length - 1], "inbox") > stamp(messages[0], "inbox");
}

function takeRecent(folder, name, limit) {
  var messages = [];
  try { messages = folder.messages(); } catch (error) { return []; }
  var total = messages.length;
  var out = [];
  var count = Math.min(total, limit);
  var fromEnd = newerAtEnd(messages);
  for (var n = 0; n < count; n++) {
    var index = fromEnd ? total - 1 - n : n;
    try { out.push(mapMessage(messages[index], name)); } catch (error) {}
  }
  return out;
}

function listMail(outlook) {
  var inbox = [];
  var sent = [];
  try { inbox = takeRecent(outlook.inbox(), "inbox", 40); } catch (error) {}
  try { sent = takeRecent(outlook.sentItems(), "sent", 15); } catch (error) {}
  return inbox.concat(sent);
}

function findIn(folder, id) {
  var messages = [];
  try { messages = folder.messages(); } catch (error) { return null; }
  var total = messages.length;
  var count = Math.min(total, 120);
  var fromEnd = newerAtEnd(messages);
  for (var n = 0; n < count; n++) {
    var index = fromEnd ? total - 1 - n : n;
    try {
      if (String(messages[index].id()) === String(id)) return messages[index];
    } catch (error) {}
  }
  return null;
}

function findMessage(outlook, id) {
  if (!id) return null;
  var found = null;
  try { found = findIn(outlook.inbox(), id); } catch (error) {}
  if (found) return found;
  try { found = findIn(outlook.sentItems(), id); } catch (error) {}
  if (found) return found;
  try { found = findIn(outlook.drafts(), id); } catch (error) {}
  return found;
}

function createDraft(outlook, payload) {
  var original = findMessage(outlook, payload.originalId);
  var draft = null;
  if (original) {
    try { draft = outlook.reply(original); } catch (error) {}
  }
  if (!draft) {
    draft = outlook.OutgoingMessage({
      subject: payload.subject || "",
      content: payload.body || ""
    });
    var people = String(payload.to || "").split(",");
    for (var i = 0; i < people.length; i++) {
      var address = people[i].trim();
      if (!address) continue;
      try {
        var recipient = outlook.Recipient({
          emailAddress: outlook.EmailAddress({ address: address })
        });
        draft.toRecipients.push(recipient);
      } catch (error) {}
    }
  } else {
    try { draft.content = payload.body || ""; } catch (error) {}
  }
  try { draft.save(); } catch (error) {}
  try { return String(draft.id() || ""); } catch (error) { return ""; }
}

function sendSaved(outlook, payload) {
  var message = findMessage(outlook, payload.id);
  if (!message) throw new Error("missing-draft");
  outlook.send(message);
}

function readBody(outlook, payload) {
  var message = findMessage(outlook, payload.id);
  if (!message) return "";
  try { return String(message.content() || "").slice(0, 4000); } catch (error) { return ""; }
}
`;

export const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 6))
}
function Fail([string]$code) {
  Emit @{ ok = $false; code = $code }
  exit 0
}
function Preview([string]$text) {
  if (-not $text) { return '' }
  $flat = ($text -replace '\\s+', ' ').Trim()
  if ($flat.Length -gt 240) { return $flat.Substring(0, 240) }
  return $flat
}
function Smtp($entry) {
  try {
    if ($entry.Type -eq 'EX') { return [string]$entry.GetExchangeUser().PrimarySmtpAddress }
    return [string]$entry.Address
  } catch { return '' }
}
$op = [string]$env:PA_OUTLOOK_OP
$payload = @{}
if ($env:PA_OUTLOOK_PAYLOAD) {
  try {
    $bytes = [Convert]::FromBase64String($env:PA_OUTLOOK_PAYLOAD)
    $payload = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  } catch { Fail 'payload' }
}
try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
} catch { Fail 'not-running' }
$ns = $outlook.Session
if ($op -eq 'detect') {
  $account = ''
  try { $account = Smtp $ns.CurrentUser.AddressEntry } catch {}
  if ($account -notlike '*@*') { try { $account = [string]$ns.CurrentUser.Address } catch {} }
  if ($account -notlike '*@*') {
    try {
      foreach ($acct in $ns.Accounts) {
        $smtp = ''
        try { $smtp = [string]$acct.SmtpAddress } catch {}
        if ($smtp -notlike '*@*') {
          try { $smtp = Smtp $acct.CurrentUser.AddressEntry } catch {}
        }
        if ($smtp -like '*@*') { $account = $smtp; break }
      }
    } catch {}
  }
  $inboxOk = $false
  try {
    $inbox = $ns.GetDefaultFolder(6)
    $null = $inbox.Items.Count
    $inboxOk = $true
  } catch {}
  if ($account -like '*@*') {
    Emit @{ ok = $true; state = 'signed-in'; account = $account; inbox = $inboxOk }
    exit 0
  }
  if ($inboxOk) {
    Emit @{ ok = $true; state = 'signed-in'; account = ''; inbox = $true }
    exit 0
  }
  Emit @{ ok = $true; state = 'signed-out'; account = ''; inbox = $false }
  exit 0
}
function MapItem($item, $folder) {
  $from = ''
  try { $from = Smtp $item.Sender } catch {}
  if (-not $from) { try { $from = [string]$item.SenderEmailAddress } catch {} }
  $to = ''
  try { $to = [string]$item.To } catch {}
  $date = ''
  try {
    $when = $item.ReceivedTime
    if ($folder -eq 'sent') { $when = $item.SentOn }
    $date = ([datetime]$when).ToUniversalTime().ToString('o')
  } catch {}
  $unread = $false
  try { $unread = [bool]$item.UnRead } catch {}
  $body = ''
  try { $body = Preview ([string]$item.Body) } catch {}
  return @{
    id = [string]$item.EntryID
    from = $from
    to = $to
    subject = [string]$item.Subject
    date = $date
    preview = $body
    unread = $unread
    folder = $folder
  }
}
function Take($folder, $name, $limit) {
  $items = $folder.Items
  try { $items.Sort('[ReceivedTime]', $true) } catch {}
  $count = [Math]::Min($limit, $items.Count)
  $out = @()
  for ($i = 1; $i -le $count; $i++) {
    try { $out += MapItem $items.Item($i) $name } catch {}
  }
  return $out
}
if ($op -eq 'list') {
  $messages = @()
  $messages += Take ($ns.GetDefaultFolder(6)) 'inbox' 40
  try { $messages += Take ($ns.GetDefaultFolder(5)) 'sent' 15 } catch {}
  Emit @{ ok = $true; messages = $messages }
  exit 0
}
if ($op -eq 'read') {
  $item = $ns.GetItemFromID([string]$payload.id)
  $text = ''
  try { $text = [string]$item.Body } catch {}
  if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) }
  Emit @{ ok = $true; body = $text }
  exit 0
}
# OP_DRAFT
if ($op -eq 'draft') {
  $reply = $null
  if ($payload.originalId) {
    try {
      $orig = $ns.GetItemFromID([string]$payload.originalId)
      $reply = $orig.Reply()
    } catch {}
  }
  if (-not $reply) {
    $reply = $outlook.CreateItem(0)
    $reply.To = [string]$payload.to
    $reply.Subject = [string]$payload.subject
  }
  $reply.Body = [string]$payload.body
  $reply.Save()
  Emit @{ ok = $true; id = [string]$reply.EntryID }
  exit 0
}
# OP_SEND
if ($op -eq 'send') {
  $item = $ns.GetItemFromID([string]$payload.id)
  $item.Send()
  Emit @{ ok = $true }
  exit 0
}
Fail 'script'
`;
