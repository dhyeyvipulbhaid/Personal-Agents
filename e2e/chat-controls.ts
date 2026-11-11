import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type {
  ChatRequest,
  ModelAdapter,
} from "../packages/host/src/models/adapter.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("example.com")) {
    return new Response("<html><title>Example Domain</title></html>");
  }
  return originalFetch(input, init);
}) as typeof fetch;

function userText(request: ChatRequest): string {
  return (
    request.messages.filter((message) => message.role === "user").at(-1)
      ?.content ?? ""
  );
}

const adapter: ModelAdapter = {
  async listModels() {
    return [
      { name: "qwen3:4b", tools: true, streaming: true, structured: true },
      { name: "qwen3:8b", tools: true, streaming: true, structured: true },
      {
        name: "qwen2.5-coder:7b",
        tools: true,
        streaming: true,
        structured: true,
      },
    ];
  },
  async chat(request, onDelta, signal) {
    const text = userText(request);
    if (text.includes("page title")) {
      if (request.tools && request.tools.length > 0) {
        return {
          text: "",
          toolCall: {
            name: "browser.open",
            arguments: JSON.stringify({ url: "https://example.com" }),
          },
        };
      }
      return { text: "That visit was not allowed." };
    }
    if (text.includes("stream this")) {
      onDelta({ token: "Working" });
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
      return { text: "should not finish" };
    }
    if (text.includes("mailbox")) {
      if (request.tools && request.tools.length > 0) {
        return {
          text: "",
          toolCall: {
            name: "browser.open",
            arguments: JSON.stringify({ url: "https://example.com" }),
          },
        };
      }
      return { text: "should not answer after stop" };
    }
    if (text.includes("ping again")) {
      return { text: "pong again" };
    }
    return { text: "pong" };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const dir = mkdtempSync(join(tmpdir(), "pa-chat-controls-"));
const app = new DesktopApp({
  dataDir: dir,
  adapter,
  probe: async () => "running",
});
await app.start();
const methods = app.methods();

async function send(page: import("playwright").Page, text: string) {
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

  await send(page, "open example.com and tell me the page title.");
  await page.getByRole("button", { name: "Approve" }).waitFor();
  await page.getByRole("button", { name: "Deny" }).waitFor();
  if ((await page.getByRole("button", { name: "Stop" }).count()) !== 1) {
    throw new Error("the turn ended while the visit was waiting");
  }
  await page.getByRole("button", { name: "Deny" }).click();
  await page
    .locator(".bubble.assistant", {
      hasText: "Not allowed: I didn't open example.com.",
    })
    .waitFor();
  await page.getByRole("button", { name: "Send" }).waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("the denied card still has an Approve button");
  }

  await send(page, "stream this");
  await page.locator(".bubble.assistant", { hasText: "Working" }).waitFor();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Send" }).waitFor();

  await send(page, "ping");
  await page.locator(".bubble.assistant", { hasText: "pong" }).waitFor();

  await send(page, "Open example.com, then summarize my mailbox.");
  await page.getByRole("button", { name: "Approve" }).waitFor();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.locator(".bubble.assistant", { hasText: "Stopped." }).waitFor();
  await page.getByRole("button", { name: "Send" }).waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("stop left the approval card open");
  }

  await send(page, "ping again");
  await page.locator(".bubble.assistant", { hasText: "pong again" }).waitFor();
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  app.close();
}
