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
          name: "browser.open",
          arguments: JSON.stringify({ url: "https://example.com" }),
        },
      };
    }
    return { text: "The page title is Example Domain." };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const dir = mkdtempSync(join(tmpdir(), "pa-browser-title-"));
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
  await page
    .locator("#draft")
    .fill("open example.com and tell me the page title.");
  await page.getByRole("button", { name: "Send" }).click();
  const approve = page.getByRole("button", { name: "Approve" });
  await approve.waitFor();
  const cards = await page.locator(".inline-approval").allTextContents();
  if (cards.length !== 1 || !cards[0]?.includes("visit example.com")) {
    throw new Error(`approval cards were ${cards.join(" | ")}`);
  }
  if ((await page.getByRole("button", { name: "Stop" }).count()) !== 1) {
    throw new Error("the turn ended while the visit was still waiting");
  }
  await approve.click();
  await page
    .locator(".bubble.assistant", {
      hasText: "The page title is Example Domain.",
    })
    .waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("a second approval was still waiting");
  }
  const after = await page.locator(".inline-approval").allTextContents();
  if (after.some((text) => text.includes("browser.open"))) {
    throw new Error(`second card was ${after.join(" | ")}`);
  }
  if (
    seen.filter((request) => request.tools && request.tools.length > 0)
      .length !== 1
  ) {
    throw new Error("tools were offered more than once");
  }
  await page.getByRole("button", { name: "Send" }).waitFor();
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  app.close();
}
