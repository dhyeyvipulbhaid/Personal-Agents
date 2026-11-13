import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeExtractor } from "memory-bank";
import { type ActivityEntry, Approvals } from "../approvals/approvals.ts";
import { DesktopApp } from "../desktop.ts";
import type { ChatRequest, ModelAdapter } from "../models/adapter.ts";
import {
  BrowserDrive,
  type CdpClient,
  chromeExecutable,
  chromeFrontCommand,
  chromeLaunchArgs,
  connectChrome,
  type DeadlineTimers,
  openSocket,
  waitForPage,
} from "./drive.ts";
import { BrowserSession } from "./session.ts";

type Send = { method: string; params?: Record<string, unknown> };

class SignInDocument {
  title = "Sign in";
  readyState = "complete";
  visibilityState = "visible";
  email = "";
  status = "";
  clicked = 0;

  hasFocus(): boolean {
    return true;
  }

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
  private href = "about:blank";

  constructor(private readonly page: SignInDocument) {}

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sends.push({ method, params });
    if (method === "Page.navigate") {
      this.href = String(params?.url ?? this.href);
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      const value = new Function(
        "document",
        "location",
        `"use strict"; return (${expression});`,
      )(this.page, { href: this.href });
      return { result: { value } };
    }
    if (method === "Page.captureScreenshot") {
      return { data: Buffer.from("png-bytes").toString("base64") };
    }
    return {};
  }

  async close(): Promise<void> {}
}

function manualTime(): {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  timers: DeadlineTimers;
} {
  let time = 0;
  return {
    clock: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    timers: {
      set() {
        return 0;
      },
      clear() {},
    },
  };
}

function pageValue(
  page: SignInDocument,
  expression: string,
  href: string,
): unknown {
  return new Function(
    "document",
    "location",
    `"use strict"; return (${expression});`,
  )(page, { href });
}

function harness(options?: {
  executable?: string | null;
  debuggingBlocked?: boolean;
  connect?: (page: SignInDocument) => Promise<CdpClient>;
  platform?: NodeJS.Platform;
  activate?: (command: readonly string[]) => Promise<void>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timers?: DeadlineTimers;
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
    platform: options?.platform ?? "linux",
    activate: options?.activate ?? (async () => {}),
    clock: options?.clock,
    sleep: options?.sleep,
    timers: options?.timers,
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
    memoryExtractor: createFakeExtractor(() => []),
    chromePath: "chrome",
    browserConnect: async () => {
      let href = "about:blank";
      return {
        async send(method: string, params?: Record<string, unknown>) {
          sends.push(method);
          if (method === "Page.navigate") {
            href = String(params?.url ?? href);
          }
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            return {
              result: { value: pageValue(page, expression, href) },
            };
          }
          return {};
        },
        async close() {},
      };
    },
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
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    async chat(request) {
      const text =
        request.messages.filter((message) => message.role === "user").at(-1)
          ?.content ?? "";
      if (text.includes("sign in page")) {
        return {
          text: "",
          toolCall: {
            name: "browser.navigate",
            arguments: JSON.stringify({ url: "https://sign-in.test/" }),
          },
        };
      }
      if (text.includes("click")) {
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
    memoryExtractor: createFakeExtractor(() => []),
    chromePath: "chrome",
    browserConnect: async () => {
      let href = "about:blank";
      return {
        async send(method: string, params?: Record<string, unknown>) {
          if (method === "Page.navigate") {
            href = String(params?.url ?? href);
          }
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            return {
              result: { value: pageValue(page, expression, href) },
            };
          }
          return {};
        },
        async close() {},
      };
    },
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

test("a hung navigate command finishes while chat stays reachable", async () => {
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
            arguments: JSON.stringify({ url: "https://www.apple.com/" }),
          },
        };
      }
      return { text: "Opened www.apple.com. The page is still loading." };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const app = new DesktopApp({
    dataDir: mkdtempSync(join(tmpdir(), "pa-drive-hang-")),
    adapter,
    probe: async () => "running",
    memoryExtractor: createFakeExtractor(() => []),
    chromePath: "chrome",
    browserConnect: async () => ({
      send(method: string) {
        if (method === "Page.navigate" || method === "Runtime.evaluate") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      },
      async close() {},
    }),
  });
  await app.start();
  const methods = app.methods();
  try {
    const send = methods.chat_send({
      text: "Navigate to https://www.apple.com",
    });
    const pending = await waitFor(methods);
    expect(pending.summary).toBe("navigate to www.apple.com");
    const approved = await Promise.race([
      Promise.resolve(
        methods.chat_approve({ id: pending.id, action: "approve" }),
      ).then(() => "ok"),
      Bun.sleep(1_000).then(() => "hung"),
    ]);
    expect(approved).toBe("ok");
    const state = await Promise.race([
      Promise.resolve(methods.chat_state({})).then(() => "ok"),
      Bun.sleep(1_000).then(() => "hung"),
    ]);
    expect(state).toBe("ok");
    const done = await Promise.race([
      Promise.resolve(send).then((raw) => raw),
      Bun.sleep(12_000).then(() => "hung"),
    ]);
    expect(done).not.toBe("hung");
    const view = JSON.parse(String(done)) as {
      messages: { role: string; text: string }[];
    };
    expect(
      view.messages.some((message) =>
        message.text.includes("Could not confirm"),
      ),
    ).toBe(true);
    expect(
      view.messages.some((message) => message.text.includes("iPhone")),
    ).toBe(false);
  } finally {
    app.close();
  }
}, 20_000);

test("a hung location check does not claim the page opened", async () => {
  const { drive, approvals } = harness({
    connect: async () => ({
      send(method: string) {
        if (method === "Runtime.evaluate") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      },
      async close() {},
    }),
  });
  const pending = drive.navigate("https://www.apple.com/");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await Promise.race([
    pending,
    Bun.sleep(8_000).then(() => "hung" as const),
  ]);
  expect(result).not.toBe("hung");
  if (result === "hung") {
    throw new Error("navigate hung");
  }
  expect(result.ok).toBe(false);
  expect(result.allowed).toBe(true);
  expect(result.message).toBe(
    "Could not confirm that www.apple.com opened in Chrome.",
  );
  expect(drive.hasSession()).toBe(false);
}, 12_000);

test("a silent debugging port does not stall past its deadline", async () => {
  const server = createServer((socket) => {
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const result = await Promise.race([
      waitForPage(port, 400).then(
        () => "opened",
        () => "failed",
      ),
      Bun.sleep(1_500).then(() => "hung"),
    ]);
    expect(result).toBe("failed");
  } finally {
    server.close();
  }
});

test("a debugging command that never replies is bounded", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, wsServer) {
      if (wsServer.upgrade(request)) {
        return undefined;
      }
      return new Response("no");
    },
    websocket: {
      message() {},
    },
  });
  const client = await openSocket(
    `ws://${server.hostname}:${server.port}`,
    () => {},
    200,
  );
  try {
    const result = await Promise.race([
      client.send("Page.navigate", { url: "https://www.apple.com/" }).then(
        () => "replied",
        (error: Error) => error.message,
      ),
      Bun.sleep(1_000).then(() => "hung"),
    ]);
    expect(result).not.toBe("hung");
    expect(String(result)).toContain("Page.navigate");
    const next = await Promise.race([
      client.send("Runtime.evaluate").then(
        () => "replied",
        (error: Error) => error.message,
      ),
      Bun.sleep(1_000).then(() => "hung"),
    ]);
    expect(next).not.toBe("hung");
  } finally {
    await client.close();
    server.stop(true);
  }
});

test("a huge Chrome result does not stall the next command", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, wsServer) {
      if (wsServer.upgrade(request)) {
        return undefined;
      }
      return new Response("no");
    },
    websocket: {
      message(socket, message) {
        const text = String(message);
        const id = Number(/"id":(\d+)/.exec(text)?.[1] ?? "0");
        if (text.includes("Page.captureScreenshot")) {
          socket.send(
            `{"id":${id},"result":{"data":"${"A".repeat(500_000)}"}}`,
          );
          return;
        }
        socket.send(`{"id":${id},"result":{}}`);
      },
    },
  });
  const client = await openSocket(
    `ws://${server.hostname}:${server.port}`,
    () => {},
    1_000,
  );
  try {
    const shot = await Promise.race([
      client.send("Page.captureScreenshot").then(
        () => "ok",
        (error: Error) => error.message,
      ),
      Bun.sleep(2_000).then(() => "hung"),
    ]);
    expect(shot).not.toBe("hung");
    expect(String(shot)).toContain("too large");
    const next = await Promise.race([
      client.send("Runtime.evaluate").then(() => "ok"),
      Bun.sleep(1_000).then(() => "hung"),
    ]);
    expect(next).toBe("ok");
  } finally {
    await client.close();
    server.stop(true);
  }
});

test("a bare host and its full URL navigate to the same page", async () => {
  const pairs = [
    ["www.example.com", "https://www.example.com"],
    ["en.wikipedia.org/wiki/Earth", "https://en.wikipedia.org/wiki/Earth"],
    ["www.bbc.com/news", "https://www.bbc.com/news"],
  ];
  for (const [name, full] of pairs) {
    expect(await issuedNavigation(name)).toBe(await issuedNavigation(full));
  }
});

test("a closed Chrome is launched again instead of a false open", async () => {
  let connects = 0;
  let open = true;
  const navigated: string[] = [];
  const { drive, approvals } = harness({
    connect: async (page) => {
      connects += 1;
      const generation = connects;
      const stand = new StandIn(page);
      return {
        async send(method, params) {
          if (generation === 1 && !open) {
            throw new Error("Chrome debugging socket closed.");
          }
          if (method === "Page.navigate") {
            navigated.push(String(params?.url ?? ""));
          }
          return stand.send(method, params);
        },
        async close() {
          await stand.close();
        },
      };
    },
  });
  const first = drive.navigate("https://www.example.com");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const opened = await first;
  expect(opened.ok).toBe(true);
  expect(opened.message).toBe("Opened www.example.com in Chrome.");
  expect(connects).toBe(1);

  open = false;
  const second = drive.navigate("www.example.com");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const again = await second;
  expect(again.ok).toBe(true);
  expect(again.message).toBe("Opened www.example.com in Chrome.");
  expect(again.message).not.toContain("still loading");
  expect(connects).toBe(2);
  expect(navigated).toEqual([
    "https://www.example.com/",
    "https://www.example.com/",
  ]);
});

test("a stale debugging socket is replaced instead of reporting the page open", async () => {
  let connects = 0;
  const { drive, approvals } = harness({
    connect: async (page) => {
      connects += 1;
      const generation = connects;
      let navigated = 0;
      const stand = new StandIn(page);
      return {
        send(method, params) {
          if (
            generation === 1 &&
            method === "Page.navigate" &&
            navigated >= 1
          ) {
            return new Promise(() => {});
          }
          if (method === "Page.navigate") {
            navigated += 1;
          }
          return stand.send(method, params);
        },
        async close() {
          await stand.close();
        },
      };
    },
  });
  const first = drive.navigate("https://en.wikipedia.org/wiki/Earth");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect((await first).message).toBe("Opened en.wikipedia.org in Chrome.");

  const second = drive.navigate("en.wikipedia.org/wiki/Earth");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const again = await second;
  expect(again.ok).toBe(true);
  expect(again.message).toBe("Opened en.wikipedia.org in Chrome.");
  expect(again.message).not.toContain("still loading");
  expect(connects).toBe(2);
  expect(drive.pageUrl()).toBe("https://en.wikipedia.org/wiki/Earth");
}, 12_000);

test("navigate that never reaches a window does not claim the page is loading", async () => {
  const { drive, approvals } = harness({
    connect: async () => ({
      send(method: string) {
        if (method === "Page.navigate") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      },
      async close() {},
    }),
  });
  const pending = drive.navigate("https://www.bbc.com/news");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.message).toBe(
    "Could not confirm that www.bbc.com opened in Chrome.",
  );
  expect(result.message).not.toContain("still loading");
  expect(result.message).not.toContain("Opened");
  expect(drive.hasSession()).toBe(false);
  expect(drive.pageUrl()).toBe("");
}, 12_000);

test("a navigate is focused before the host is checked", async () => {
  const sends: string[] = [];
  const commands: string[][] = [];
  const { drive, approvals } = harness({
    platform: "darwin",
    activate: async (command) => {
      commands.push([...command]);
    },
    connect: async () => ({
      send(method: string, params?: Record<string, unknown>) {
        sends.push(method);
        if (method === "Page.navigate") {
          expect(params?.url).toBe("https://www.example.com/");
        }
        if (method === "Runtime.evaluate") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      },
      async close() {},
    }),
  });
  const pending = drive.navigate("www.example.com");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.message).toBe(
    "Could not confirm that www.example.com opened in Chrome.",
  );
  const navigateAt = sends.indexOf("Page.navigate");
  const frontAt = sends.indexOf("Page.bringToFront");
  expect(navigateAt).toBeGreaterThanOrEqual(0);
  expect(frontAt).toBeGreaterThan(navigateAt);
  expect(commands).toEqual([
    ["osascript", "-e", 'tell application "Google Chrome" to activate'],
    ["open", "-a", "Google Chrome", "https://www.example.com/"],
    ["osascript", "-e", 'tell application "Google Chrome" to activate'],
  ]);
  expect(drive.hasSession()).toBe(false);
}, 12_000);

test("the first navigate after launch does not treat the startup tab as opened", async () => {
  let connects = 0;
  const commands: string[][] = [];
  const { drive, approvals } = harness({
    platform: "darwin",
    ...manualTime(),
    activate: async (command) => {
      commands.push([...command]);
    },
    connect: async () => {
      connects += 1;
      const generation = connects;
      let href = "about:blank";
      return {
        async send(method: string, params?: Record<string, unknown>) {
          if (method === "Page.navigate" && generation > 1) {
            href = "https://www.apple.com/";
          }
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("visibilityState")) {
              return {
                result: {
                  value: JSON.stringify({
                    href,
                    state: generation > 1 ? "visible" : "hidden",
                  }),
                },
              };
            }
            return { result: { value: "complete" } };
          }
          if (method === "Target.getTargetInfo") {
            return {
              targetInfo: {
                type: "page",
                url: href,
                attached: generation > 1,
              },
            };
          }
          return {};
        },
        async close() {},
      };
    },
  });
  const pending = drive.navigate("https://apple.com/");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.message).toBe("Opened apple.com in Chrome.");
  expect(result.text).toBeUndefined();
  expect(connects).toBe(2);
  expect(drive.pageUrl()).toBe("https://apple.com/");
  expect(commands).toContainEqual([
    "open",
    "-a",
    "Google Chrome",
    "https://apple.com/",
  ]);
});

test("an unverified navigate does not claim the page opened", async () => {
  let connects = 0;
  const commands: string[][] = [];
  const { drive, approvals } = harness({
    platform: "darwin",
    ...manualTime(),
    activate: async (command) => {
      commands.push([...command]);
    },
    connect: async () => {
      connects += 1;
      return {
        async send(method: string, params?: Record<string, unknown>) {
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("visibilityState")) {
              return {
                result: {
                  value: JSON.stringify({
                    href: "about:blank",
                    state: "visible",
                  }),
                },
              };
            }
            return { result: { value: "complete" } };
          }
          if (method === "Target.getTargetInfo") {
            return {
              targetInfo: {
                type: "page",
                url: "about:blank",
                attached: true,
              },
            };
          }
          return {};
        },
        async close() {},
      };
    },
  });
  const pending = drive.navigate("apple.com");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.message).toBe(
    "Could not confirm that apple.com opened in Chrome.",
  );
  expect(result.message).not.toContain("Opened");
  expect(result.message).not.toContain("still loading");
  expect(connects).toBe(2);
  expect(drive.hasSession()).toBe(false);
  expect(drive.pageUrl()).toBe("");
  expect(commands.filter((command) => command[0] === "open")).toEqual([
    ["open", "-a", "Google Chrome", "https://apple.com/"],
  ]);
});

test("a hidden tab on the right host is not reported as opened", async () => {
  let connects = 0;
  const { drive, approvals } = harness({
    platform: "darwin",
    ...manualTime(),
    activate: async () => {},
    connect: async () => {
      connects += 1;
      const generation = connects;
      return {
        async send(method: string, params?: Record<string, unknown>) {
          if (method === "Page.navigate" && generation === 1) {
            return {};
          }
          if (method === "Runtime.evaluate") {
            const expression = String(params?.expression ?? "");
            if (expression.includes("visibilityState")) {
              const shown = generation > 1;
              return {
                result: {
                  value: JSON.stringify({
                    href: "https://www.meta.com/",
                    state: shown ? "visible" : "hidden",
                  }),
                },
              };
            }
          }
          if (method === "Target.getTargetInfo") {
            return {
              targetInfo: {
                type: "page",
                url: "https://www.meta.com/",
                attached: true,
              },
            };
          }
          return {};
        },
        async close() {},
      };
    },
  });
  const pending = drive.navigate("https://www.meta.com/");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(connects).toBe(2);
  expect(result.ok).toBe(true);
  expect(result.message).toBe("Opened www.meta.com in Chrome.");
  expect(result.text).toBeUndefined();
});

test("linux and windows do not run the macOS Chrome activate command", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const commands: string[][] = [];
    const sends: string[] = [];
    const { drive, approvals } = harness({
      platform,
      ...manualTime(),
      activate: async (command) => {
        commands.push([...command]);
      },
      connect: async (page) => {
        const stand = new StandIn(page);
        return {
          async send(method, params) {
            sends.push(method);
            return stand.send(method, params);
          },
          async close() {
            await stand.close();
          },
        };
      },
    });
    const pending = drive.navigate("https://www.bbc.com/news");
    approvals.approve(approvals.pending()[0]?.id ?? "");
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Opened www.bbc.com in Chrome.");
    expect(commands).toEqual([]);
    expect(sends.indexOf("Page.bringToFront")).toBeGreaterThan(
      sends.indexOf("Page.navigate"),
    );
  }
});

test("a background read shows on the widget without opening Chrome", async () => {
  let connects = 0;
  const { drive, approvals } = harness({
    connect: async (page) => {
      connects += 1;
      return new StandIn(page);
    },
  });
  const pending = drive.read("https://example.com/");
  const approval = approvals.pending()[0];
  expect(approval?.summary).toBe("visit example.com");
  expect(drive.site()).toBe("example.com");
  expect(drive.currentStep()).toBe("read example.com");
  expect(drive.hasSession()).toBe(true);
  expect(connects).toBe(0);
  approvals.approve(approval?.id ?? "");
  const result = await pending;
  expect(result.opened).toBe(true);
  expect(result.text).toContain("from the background");
  expect(connects).toBe(0);
  expect(drive.pageUrl()).toBe("https://example.com/");
  expect(drive.currentStep()).toBe("done read example.com");
  expect(drive.busy()).toBe(false);
  await drive.halt();
  expect(drive.hasSession()).toBe(false);
  expect(drive.site()).toBe("");
});

test("a real Chrome tab matches the reported open state", async () => {
  const chrome = chromeExecutable();
  if (!chrome) {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "pa-real-chrome-"));
  const box: { client: CdpClient | null } = { client: null };
  const { drive, approvals } = harness({
    executable: chrome,
    connect: async () => {
      box.client = await connectChrome(chrome, join(dir, "profile"));
      return box.client;
    },
  });
  const pending = drive.navigate("https://www.apple.com/");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  const live = box.client
    ? ((await box.client.send("Runtime.evaluate", {
        expression:
          "JSON.stringify({href:location.href,state:document.visibilityState})",
        returnByValue: true,
      })) as { result?: { value?: string } })
    : null;
  const proof = JSON.parse(live?.result?.value ?? "{}") as {
    href?: string;
    state?: string;
  };
  if (result.ok) {
    expect(proof.href ?? "").toMatch(/apple\.com/);
    expect(proof.state).toBe("visible");
    expect(result.message).toBe("Opened www.apple.com in Chrome.");
  } else {
    expect(result.message ?? "").toContain("Could not confirm");
    expect(result.message ?? "").not.toMatch(/^Opened /);
  }
  await drive.close();
}, 45_000);

test("macOS focuses Google Chrome and other platforms do not", () => {
  expect(chromeFrontCommand("darwin")).toEqual([
    "osascript",
    "-e",
    'tell application "Google Chrome" to activate',
  ]);
  expect(chromeFrontCommand("linux")).toBeNull();
  expect(chromeFrontCommand("win32")).toBeNull();
});

test("a Chrome that cannot be relaunched is not reported open", async () => {
  let connects = 0;
  let open = true;
  const { drive, approvals } = harness({
    connect: async (page) => {
      connects += 1;
      if (connects > 1) {
        throw new Error("Chrome did not open a debugging page.");
      }
      const stand = new StandIn(page);
      return {
        async send(method, params) {
          if (!open) {
            throw new Error("Chrome debugging socket closed.");
          }
          return stand.send(method, params);
        },
        async close() {
          await stand.close();
        },
      };
    },
  });
  const first = drive.navigate("https://www.example.com/");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect((await first).ok).toBe(true);
  open = false;
  const second = drive.navigate("https://www.bbc.com/news");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const again = await second;
  expect(connects).toBe(2);
  expect(again.ok).toBe(false);
  expect(again.message).not.toContain("still loading");
  expect(again.message).not.toContain("Opened");
  expect(drive.hasSession()).toBe(false);
  expect(drive.pageUrl()).toBe("");
});

async function issuedNavigation(raw: string): Promise<string> {
  let target = "";
  const { drive, approvals } = harness({
    connect: async (page) => {
      const stand = new StandIn(page);
      return {
        async send(method, params) {
          if (method === "Page.navigate") {
            target = String(params?.url ?? "");
          }
          return stand.send(method, params);
        },
        async close() {
          await stand.close();
        },
      };
    },
  });
  const pending = drive.navigate(raw);
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(result.ok).toBe(true);
  return target;
}

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
