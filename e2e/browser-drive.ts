import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type {
  ChatRequest,
  ModelAdapter,
} from "../packages/host/src/models/adapter.ts";

type Node = {
  tag: string;
  id: string;
  value: string;
  innerText: string;
  click: () => void;
  focus: () => void;
  dispatchEvent: () => void;
  getAttribute: () => string;
};

const pageState = { email: "", status: "", clicked: 0, connects: 0 };

function element(tag: string, id: string, text: string): Node {
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

const documentStub = {
  title: "Sign in",
  readyState: "complete",
  visibilityState: "visible",
  hasFocus() {
    return true;
  },
  get body() {
    return main();
  },
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  },
  querySelectorAll(selector: string) {
    const parts = selector.split(",").map((part) => part.trim().toLowerCase());
    return elements().filter((node) =>
      parts.some((part) =>
        part.startsWith("#") ? node.id === part.slice(1) : node.tag === part,
      ),
    );
  },
};

function elements(): Node[] {
  const email = element("input", "email", "");
  Object.defineProperty(email, "value", {
    get: () => pageState.email,
    set: (value: string) => {
      pageState.email = value;
    },
  });
  const button = element("button", "go", "Sign in");
  button.click = () => {
    pageState.clicked += 1;
    pageState.status = `Welcome ${pageState.email}`;
  };
  const status = element("p", "out", "");
  Object.defineProperty(status, "innerText", { get: () => pageState.status });
  return [element("h1", "title", "Sign in"), email, button, status, main()];
}

function main(): Node {
  const node = element("main", "", "");
  Object.defineProperty(node, "innerText", {
    get: () => `Sign in ${pageState.status}`.replace(/\s+/g, " ").trim(),
  });
  return node;
}

const adapter: ModelAdapter = {
  async listModels() {
    return [
      { name: "qwen3:4b", tools: true, streaming: true, structured: true },
    ];
  },
  async chat(request) {
    const text = userText(request);
    if (request.tools && request.tools.length > 0) {
      if (text.includes("navigate")) {
        return {
          text: "",
          toolCall: {
            name: "browser.navigate",
            arguments: JSON.stringify({ url: "https://sign-in.test/" }),
          },
        };
      }
      if (text.includes("type")) {
        return {
          text: "",
          toolCall: {
            name: "browser.type",
            arguments: JSON.stringify({ selector: "#email", text: "Ada" }),
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
      return {
        text: "",
        toolCall: { name: "browser.read", arguments: "{}" },
      };
    }
    const tool = request.messages.find((message) => message.role === "tool");
    if (tool?.content.includes("Welcome Ada")) {
      return { text: "The page says Welcome Ada." };
    }
    if (
      tool?.content.includes("not allowed") ||
      tool?.content.includes('"allowed":false')
    ) {
      return { text: "That action was not allowed." };
    }
    return { text: "Done." };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

function userText(request: ChatRequest): string {
  return (
    request.messages.filter((message) => message.role === "user").at(-1)
      ?.content ?? ""
  );
}

const dir = mkdtempSync(join(tmpdir(), "pa-browser-drive-"));
const app = new DesktopApp({
  dataDir: dir,
  adapter,
  probe: async () => "running",
  chromePath: "chrome",
  browserConnect: async () => {
    pageState.connects += 1;
    let href = "about:blank";
    return {
      async send(method: string, params?: Record<string, unknown>) {
        if (method === "Page.navigate") {
          href = String(params?.url ?? href);
          return {};
        }
        if (method !== "Runtime.evaluate") {
          return {};
        }
        const expression = String(params?.expression ?? "");
        if (expression.includes("visibilityState")) {
          return {
            result: {
              value: JSON.stringify({ href, state: "visible" }),
            },
          };
        }
        return {
          result: {
            value: new Function(
              "document",
              `"use strict"; return (${expression});`,
            )(documentStub),
          },
        };
      },
      async close() {},
    };
  },
});
await app.start();
const methods = app.methods();

async function send(page: Page, text: string) {
  await page.locator("#draft").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.exposeFunction(
    "hostInvoke",
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "note_displayed_host_version") {
        return null;
      }
      if (command === "audit_log") {
        return "[]";
      }
      if (command === "host_version") {
        return "0.0.0";
      }
      if (command === "ollama_status") {
        return methods.ollama({});
      }
      const method = methods[command];
      if (!method) {
        throw new Error(`unexpected command ${command}`);
      }
      return method(args ?? {});
    },
  );
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      hostInvoke: (command: string, args?: unknown) => Promise<unknown>;
    };
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke: (command: string, args?: unknown) =>
            bridge.hostInvoke(command, args),
        },
      },
    });
  });
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/chat.html")).href,
  );

  await send(page, "navigate to the sign in page");
  await page.getByRole("button", { name: "Approve" }).waitFor();
  await page.getByRole("button", { name: "Deny" }).waitFor();
  const waiting = await page.locator(".inline-approval").allTextContents();
  if (!waiting.some((text) => text.includes("navigate to sign-in.test"))) {
    throw new Error(`navigate card was ${waiting.join(" | ")}`);
  }
  if ((await page.getByRole("button", { name: "Stop" }).count()) !== 1) {
    throw new Error("Stop was missing while navigate waited");
  }
  await page.getByRole("button", { name: "Deny" }).click();
  await page.locator(".bubble.assistant", { hasText: "not allowed" }).waitFor();
  if (Number(pageState.connects) !== 0) {
    throw new Error("deny launched Chrome");
  }
  await page.getByRole("button", { name: "Send" }).waitFor();

  await send(page, "navigate to the sign in page");
  await page.getByRole("button", { name: "Approve" }).click();
  await page
    .locator(".bubble.assistant", { hasText: "Opened sign-in.test" })
    .waitFor();
  if (Number(pageState.connects) !== 1) {
    throw new Error(`chrome connects were ${pageState.connects}`);
  }

  await send(page, "type Ada into the email field");
  const typeCard = page.locator(".inline-approval", {
    hasText: 'type "Ada" into "#email" on sign-in.test',
  });
  await typeCard.getByRole("button", { name: "Deny" }).waitFor();
  await typeCard.getByRole("button", { name: "Approve" }).click();
  await page
    .locator(".bubble.assistant", { hasText: "Done." })
    .first()
    .waitFor();

  await send(page, "click Sign in");
  const clickCard = page.locator(".inline-approval", {
    hasText: 'click "Sign in" on sign-in.test',
  });
  await clickCard.getByRole("button", { name: "Approve" }).click();
  await page
    .locator(".bubble.assistant", { hasText: "Done." })
    .nth(1)
    .waitFor();
  if (Number(pageState.clicked) !== 1 || pageState.email !== "Ada") {
    throw new Error(
      `page was clicked=${pageState.clicked} email=${pageState.email}`,
    );
  }

  await send(page, "what does the page say now");
  await page.locator(".bubble.assistant", { hasText: "Welcome Ada" }).waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("reading the open page asked again");
  }

  await send(page, "click Sign in again");
  await page.getByRole("button", { name: "Approve" }).waitFor();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.locator(".bubble.assistant", { hasText: "Stopped." }).waitFor();
  await page.getByRole("button", { name: "Send" }).waitFor();
  if (Number(pageState.clicked) !== 1) {
    throw new Error("stop still clicked the page");
  }
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("stop left the approval card open");
  }
} finally {
  await browser.close();
  app.close();
}
