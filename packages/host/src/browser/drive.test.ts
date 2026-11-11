import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActivityEntry, Approvals } from "../approvals/approvals.ts";
import { DesktopApp } from "../desktop.ts";
import type { ChatRequest, ModelAdapter } from "../models/adapter.ts";
import {
  BrowserDrive,
  type CdpClient,
  chromeExecutable,
  chromeLaunchArgs,
} from "./drive.ts";
import { BrowserSession } from "./session.ts";

type Send = { method: string; params?: Record<string, unknown> };

class SignInDocument {
  title = "Sign in";
  readyState = "complete";
  email = "";
  status = "";
  clicked = 0;

  get body(): ElementLike {
    return main(this);
  }

  querySelector(selector: string): ElementLike | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ElementLike[] {
    const parts = selector.split(",").map((part) => part.trim().toLowerCase());
    return this.elements().filter((element) =>
      parts.some((part) => {
        if (part.startsWith("#")) {
          return element.id === part.slice(1);
        }
        return element.tag === part;
      }),
    );
  }

  private elements(): ElementLike[] {
    return [
      heading(this),
      input(this),
      button(this),
      status(this),
      main(this),
      body(this),
    ];
  }
}

type ElementLike = {
  tag: string;
  id: string;
  value: string;
  innerText: string;
  click: () => void;
  focus: () => void;
  dispatchEvent: (event: { type: string }) => void;
  getAttribute: (name: string) => string;
};

function heading(doc: SignInDocument): ElementLike {
  return element("h1", "title", "Sign in", doc);
}

function input(doc: SignInDocument): ElementLike {
  const node = element("input", "email", "", doc);
  Object.defineProperty(node, "value", {
    get: () => doc.email,
    set: (value: string) => {
      doc.email = value;
    },
  });
  return node;
}

function button(doc: SignInDocument): ElementLike {
  const node = element("button", "go", "Sign in", doc);
  node.click = () => {
    doc.clicked += 1;
    doc.status = doc.email.length > 0 ? `Welcome ${doc.email}` : "Welcome";
  };
  return node;
}

function status(doc: SignInDocument): ElementLike {
  const node = element("p", "out", "", doc);
  Object.defineProperty(node, "innerText", {
    get: () => doc.status,
  });
  return node;
}

function main(doc: SignInDocument): ElementLike {
  const node = element("main", "", "", doc);
  Object.defineProperty(node, "innerText", {
    get: () => `Sign in ${doc.email} ${doc.status}`.replace(/\s+/g, " ").trim(),
  });
  return node;
}

function body(doc: SignInDocument): ElementLike {
  return main(doc);
}

function element(
  tag: string,
  id: string,
  text: string,
  _doc: SignInDocument,
): ElementLike {
  return {
    tag,
    id,
    value: "",
    innerText: text,
    click: () => {},
    focus: () => {},
    dispatchEvent: () => {},
    getAttribute: () => "",
  };
}

class StandIn implements CdpClient {
  readonly sends: Send[] = [];

  constructor(private readonly page: SignInDocument) {}

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sends.push({ method, params });
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      const value = new Function(
        "document",
        `"use strict"; return (${expression});`,
      )(this.page);
      return { result: { value } };
    }
    if (method === "Page.captureScreenshot") {
      return { data: Buffer.from("png-bytes").toString("base64") };
    }
    return {};
  }

  async close(): Promise<void> {}
}

function harness(options?: {
  executable?: string | null;
  debuggingBlocked?: boolean;
  connect?: (page: SignInDocument) => Promise<CdpClient>;
}): {
  drive: BrowserDrive;
  approvals: Approvals;
  session: BrowserSession;
  activity: ActivityEntry[];
  page: SignInDocument;
  dir: string;
} {
  const activity: ActivityEntry[] = [];
  const approvals = new Approvals((entry) => activity.push(entry));
  const session = new BrowserSession(approvals);
  const page = new SignInDocument();
  const dir = mkdtempSync(join(tmpdir(), "pa-drive-"));
  const drive = new BrowserDrive({
    approvals,
    session,
    audit: (entry) => activity.push(entry),
    executable:
      options?.executable === undefined ? "chrome" : options.executable,
    debuggingBlocked: options?.debuggingBlocked ?? false,
    dataDir: dir,
    now: () => Date.parse("2026-11-11T12:00:00.000Z"),
    connect: async () =>
      options?.connect ? options.connect(page) : new StandIn(page),
    fetchPage: async () =>
      "<title>Fetched</title><main><h1>Fetched</h1><p>from the background</p></main>",
  });
  return { drive, approvals, session, activity, page, dir };
}

test("mac and windows chrome paths both resolve", () => {
  const mac = chromeExecutable({
    platform: "darwin",
    env: {},
    home: "/Users/ada",
    exists: (path) => path.startsWith("/Users/ada/Applications/"),
  });
  expect(mac).toBe(
    "/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  const win = chromeExecutable({
    platform: "win32",
    env: {
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    },
    home: "C:\\Users\\ada",
    exists: (path) => path.includes("Program Files (x86)"),
  });
  expect(win).toBe(
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  );
});

test("chrome launches in a separate profile and stays visible", () => {
  const args = chromeLaunchArgs(
    "C:\\Users\\ada\\AppData\\Roaming\\personal-agents\\chrome-profile",
    9333,
  );
  expect(args.some((arg) => arg.includes("chrome-profile"))).toBe(true);
  expect(args.some((arg) => arg.includes("9333"))).toBe(true);
  expect(args).toContain("about:blank");
  expect(args.some((arg) => /^https?:/i.test(arg))).toBe(false);
  expect(args.some((arg) => /headless/i.test(arg))).toBe(false);
});

test("navigate never hands a URL to the default browser", () => {
  const source = readFileSync(new URL("./drive.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/spawn\(\s*["']open["']/);
  expect(source).not.toMatch(/NSWorkspace\.shared|ShellExecuteW/);
  const args = chromeLaunchArgs("/tmp/chrome-profile", 9222);
  expect(args.at(-1)).toBe("about:blank");
  expect(args.join("\n")).not.toMatch(/https?:\/\//);
});

test("a denied navigate, click, or type does not touch the page", async () => {
  let connects = 0;
  const blocked = harness({
    connect: async (page) => {
      connects += 1;
      return new StandIn(page);
    },
  });
  const navigate = blocked.drive.navigate("https://sign-in.test/");
  expect(blocked.approvals.pending()[0]?.summary).toBe(
    "navigate to sign-in.test",
  );
  blocked.approvals.deny(blocked.approvals.pending()[0]?.id ?? "");
  expect((await navigate).ok).toBe(false);
  expect(connects).toBe(0);
  expect(blocked.page.clicked).toBe(0);

  const { drive, approvals, page } = harness();
  const opened = drive.navigate("https://sign-in.test/");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect((await opened).ok).toBe(true);
  const click = drive.click("Sign in");
  expect(approvals.pending()[0]?.summary).toBe(
    'click "Sign in" on sign-in.test',
  );
  approvals.deny(approvals.pending()[0]?.id ?? "");
  expect((await click).ok).toBe(false);
  const typed = drive.type("#email", "Ada");
  expect(approvals.pending()[0]?.summary).toBe(
    'type "Ada" into "#email" on sign-in.test',
  );
  approvals.deny(approvals.pending()[0]?.id ?? "");
  expect((await typed).allowed).toBe(false);
  expect(page.clicked).toBe(0);
  expect(page.email).toBe("");
  const read = await drive.read("https://sign-in.test/");
  expect(read.text).not.toContain("Ada");
});

test("click and type reach the page and a later read sees them", async () => {
  const { drive, approvals, session, activity } = harness();
  const navigate = drive.navigate("https://sign-in.test/form");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect((await navigate).ok).toBe(true);
  const typed = drive.type("#email", "Ada");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect((await typed).ok).toBe(true);
  const click = drive.click("Sign in");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect((await click).ok).toBe(true);
  const before = approvals.pending().length;
  const read = await drive.read("https://sign-in.test/form");
  expect(approvals.pending().length).toBe(before);
  expect(read.title).toBe("Sign in");
  expect(read.headings).toContain("Sign in");
  expect(read.text).toContain("Welcome Ada");
  expect(session.liveView()).toContain("navigate to sign-in.test");
  expect(session.liveView()).toContain('click "Sign in" on sign-in.test');
  expect(
    activity.some(
      (entry) =>
        entry.decision === "browser" &&
        entry.summary.includes("Welcome") === false &&
        entry.summary.includes("Clicked"),
    ),
  ).toBe(true);
  const shot = await drive.screenshot();
  expect(approvals.pending().length).toBe(before);
  expect(shot.ok).toBe(true);
  expect(shot.path && readFileSync(shot.path, "utf8")).toBe("png-bytes");
});

test("chrome missing falls back to a background read and refuses actions", async () => {
  const { drive, approvals, activity } = harness({ executable: null });
  const navigate = await drive.navigate("https://example.com/");
  expect(navigate.ok).toBe(false);
  expect(navigate.message).toContain("Chrome is not installed");
  const click = await drive.click("Sign in");
  expect(click.message).toContain("Chrome is not installed");
  const pending = drive.read("https://example.test/story");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const read = await pending;
  expect(read.opened).toBe(true);
  expect(read.text).toContain("from the background");
  expect(
    activity.some((entry) => entry.summary.includes("Chrome is not installed")),
  ).toBe(true);
});

test("stop cancels a pending navigate before chrome starts", async () => {
  let connects = 0;
  const { drive, approvals, page } = harness({
    connect: async (doc) => {
      connects += 1;
      return new StandIn(doc);
    },
  });
  const pending = drive.navigate("https://sign-in.test/");
  expect(approvals.pending()).toHaveLength(1);
  approvals.cancelTask("browser");
  const result = await pending;
  expect(result.cancelled).toBe(true);
  expect(result.ok).toBe(false);
  expect(connects).toBe(0);
  expect(page.clicked).toBe(0);
});

test("an abort after approval does not drive the page", async () => {
  let connects = 0;
  const controller = new AbortController();
  const { drive, approvals } = harness({
    connect: async (doc) => {
      connects += 1;
      return new StandIn(doc);
    },
  });
  const pending = drive.navigate("https://sign-in.test/", controller.signal);
  approvals.approve(approvals.pending()[0]?.id ?? "");
  controller.abort();
  const result = await pending;
  expect(result.cancelled).toBe(true);
  expect(connects).toBe(0);
});

test("remote debugging blocked does not launch chrome", async () => {
  let connects = 0;
  const { drive } = harness({
    debuggingBlocked: true,
    connect: async () => {
      connects += 1;
      return new StandIn(new SignInDocument());
    },
  });
  const navigate = await drive.navigate("https://example.com/");
  expect(navigate.message).toContain("RemoteDebuggingAllowed");
  expect(connects).toBe(0);
});

test("chat shows one click card and a denial does not click", async () => {
  const sends: string[] = [];
  const page = new SignInDocument();
  const seen: ChatRequest[] = [];
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    async chat(request) {
      seen.push(request);
      const tools = request.tools?.map((tool) => tool.function.name) ?? [];
      if (tools.includes("browser.navigate") && seen.length === 1) {
        return {
          text: "",
          toolCall: {
            name: "browser.navigate",
            arguments: JSON.stringify({ url: "https://sign-in.test/" }),
          },
        };
      }
      if (tools.includes("browser.click")) {
        return {
          text: "",
          toolCall: {
            name: "browser.click",
            arguments: JSON.stringify({ text: "Sign in" }),
          },
        };
      }
      return { text: "done" };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "pa-drive-chat-"));
  const app = new DesktopApp({
    dataDir: dir,
    adapter,
    probe: async () => "running",
    chromePath: "chrome",
    browserConnect: async () => ({
      async send(method: string, params?: Record<string, unknown>) {
        sends.push(method);
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          return {
            result: {
              value: new Function(
                "document",
                `"use strict"; return (${expression});`,
              )(page),
            },
          };
        }
        return {};
      },
      async close() {},
    }),
  });
  await app.start();
  const methods = app.methods();
  try {
    const firstSend = Promise.resolve(
      methods.chat_send({ text: "open the sign in page" }),
    );
    const first = await waitFor(methods);
    expect(first.summary).toBe("navigate to sign-in.test");
    await methods.approval_act({
      action: "approve",
      id: first.id,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    await firstSend;
    expect(sends).toContain("Page.navigate");
    const secondSend = Promise.resolve(
      methods.chat_send({ text: "click sign in" }),
    );
    const second = await waitFor(methods);
    expect(second.summary).toBe('click "Sign in" on sign-in.test');
    const sendsBeforeDeny = sends.length;
    const callsBeforeDeny = seen.length;
    await methods.chat_approve({ id: second.id, action: "deny" });
    const state = JSON.parse(await secondSend) as {
      messages: { role: string; text: string }[];
    };
    expect(sends.length).toBe(sendsBeforeDeny);
    expect(seen).toHaveLength(callsBeforeDeny);
    expect(page.clicked).toBe(0);
    expect(
      state.messages.some((message) => message.text.includes("(denied)")),
    ).toBe(true);
    expect(
      state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .at(-1),
    ).toBe('Not allowed: I didn\'t click "Sign in" on sign-in.test.');
  } finally {
    app.close();
  }
});

test("stop during a pending click does not click", async () => {
  const page = new SignInDocument();
  let calls = 0;
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          toolCall: {
            name: "browser.navigate",
            arguments: JSON.stringify({ url: "https://sign-in.test/" }),
          },
        };
      }
      if (calls === 2) {
        return { text: "Opened the sign-in page." };
      }
      if (calls === 3) {
        return {
          text: "",
          toolCall: {
            name: "browser.click",
            arguments: JSON.stringify({ text: "Sign in" }),
          },
        };
      }
      return { text: "next ok" };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const app = new DesktopApp({
    dataDir: mkdtempSync(join(tmpdir(), "pa-drive-stop-")),
    adapter,
    probe: async () => "running",
    chromePath: "chrome",
    browserConnect: async () => ({
      async send(method: string, params?: Record<string, unknown>) {
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          return {
            result: {
              value: new Function(
                "document",
                `"use strict"; return (${expression});`,
              )(page),
            },
          };
        }
        return {};
      },
      async close() {},
    }),
  });
  await app.start();
  const methods = app.methods();
  try {
    const open = Promise.resolve(
      methods.chat_send({ text: "open the sign in page" }),
    );
    const first = await waitFor(methods);
    await methods.chat_approve({ id: first.id, action: "approve" });
    await open;
    const click = Promise.resolve(methods.chat_send({ text: "click sign in" }));
    await waitFor(methods);
    const stopped = methods.chat_stop({});
    const outcome = await Promise.race([
      Promise.all([click, stopped]).then(([raw]) => raw),
      Bun.sleep(400).then(() => "hung"),
    ]);
    expect(outcome).not.toBe("hung");
    const state = JSON.parse(String(outcome)) as {
      messages: { role: string; text: string }[];
    };
    expect(page.clicked).toBe(0);
    expect(JSON.parse(await methods.approvals({}))).toEqual([]);
    expect(
      state.messages.some((message) => message.text.includes("Stopped.")),
    ).toBe(true);
    const next = JSON.parse(await methods.chat_send({ text: "say hello" })) as {
      messages: { role: string; text: string }[];
    };
    expect(next.messages.some((message) => message.text === "next ok")).toBe(
      true,
    );
  } finally {
    app.close();
  }
});

async function waitFor(
  methods: ReturnType<DesktopApp["methods"]>,
): Promise<{ id: string; summary: string }> {
  const started = Date.now();
  while (Date.now() - started < 800) {
    const pending = JSON.parse(await methods.approvals({})) as {
      id: string;
      summary: string;
    }[];
    const item = pending[0];
    if (item) {
      return item;
    }
    await Bun.sleep(20);
  }
  throw new Error("no approval appeared");
}
