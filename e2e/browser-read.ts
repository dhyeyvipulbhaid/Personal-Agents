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

const story =
  "<!doctype html><html><head><title>Example Domain</title></head><body><main><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p></main></body></html>";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("example.com")) {
    return new Response(story);
  }
  return originalFetch(input, init);
}) as typeof fetch;

const seen: ChatRequest[] = [];
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
  async chat(request) {
    seen.push(request);
    if (request.tools && request.tools.length > 0) {
      return {
        text: "",
        toolCall: {
          name: "browser.read",
          arguments: JSON.stringify({ url: "https://example.com" }),
        },
      };
    }
    const tool = request.messages.find((message) => message.role === "tool");
    if (!tool?.content.includes("illustrative examples in documents")) {
      return { text: "The tool did not return the page text." };
    }
    return {
      text: "Example Domain says this domain is for use in illustrative examples in documents.",
    };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const dir = mkdtempSync(join(tmpdir(), "pa-browser-read-"));
const app = new DesktopApp({
  dataDir: dir,
  adapter,
  probe: async () => "running",
});
await app.start();
const methods = app.methods();

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
  await page.locator("#draft").fill("what does example.com say?");
  await page.getByRole("button", { name: "Send" }).click();
  const approve = page.getByRole("button", { name: "Approve" });
  await approve.waitFor();
  const cards = await page.locator(".inline-approval").allTextContents();
  if (cards.length !== 1 || !cards[0]?.includes("visit example.com")) {
    throw new Error(`approval cards were ${cards.join(" | ")}`);
  }
  await approve.click();
  await page
    .locator(".bubble.assistant", {
      hasText: "illustrative examples in documents",
    })
    .waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("a second approval was still waiting");
  }
  await page.getByRole("button", { name: "Send" }).waitFor();
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  app.close();
}
