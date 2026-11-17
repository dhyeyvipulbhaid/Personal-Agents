import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type { ModelAdapter } from "../packages/host/src/models/adapter.ts";

const paper = "https://arxiv.org/abs/2609.09153";
const fetched: string[] = [];
const opened: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input);
  if (target.includes("arxiv.org")) {
    fetched.push(target);
    return new Response(
      "<title>Paper</title><main><p>The method trains a small local router.</p></main>",
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;

const adapter: ModelAdapter = {
  async listModels() {
    return [
      { name: "qwen3:8b", tools: true, streaming: true, structured: true },
    ];
  },
  async chat(request) {
    if (request.tools && request.tools.length > 0) {
      return {
        text: "",
        toolCall: {
          name: "browser.navigate",
          arguments: JSON.stringify({ url: "https://arxiv.org" }),
        },
      };
    }
    const packet = request.messages
      .map((message) => message.content)
      .join("\n");
    if (packet.includes("small local router")) {
      return {
        text: `The paper describes a small local router.\n${paper}`,
      };
    }
    return { text: "Opened arxiv.org in Chrome." };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const dir = mkdtempSync(join(tmpdir(), "pa-paper-summary-"));
const app = new DesktopApp({
  dataDir: dir,
  adapter,
  probe: async () => "running",
  memoryExtractor: { extract: () => [] },
  chromePath: "chrome",
  browserConnect: async () => ({
    async send(method: string, params?: Record<string, unknown>) {
      if (method === "Page.navigate") {
        opened.push(String(params?.url ?? ""));
      }
      return {};
    },
    async close() {},
  }),
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
    .fill("summarise this paper https://arxiv.org/abs/2609.09153");
  await page.getByRole("button", { name: "Send" }).click();
  const approve = page.getByRole("button", { name: "Approve" });
  await approve.waitFor();
  const cards = await page.locator(".inline-approval").allTextContents();
  if (cards.length !== 1 || !cards[0]?.includes("visit arxiv.org")) {
    throw new Error(`approval cards were ${cards.join(" | ")}`);
  }
  await approve.click();
  const summary = page.locator(".bubble.assistant").last();
  const link = summary.getByRole("link", { name: "arxiv.org" });
  await link.waitFor();
  const href = (await link.getAttribute("href")) ?? "";
  if (!href.includes("/abs/2609.09153")) {
    throw new Error(`the link was ${href}`);
  }
  const text = (await summary.textContent()) ?? "";
  if (!text.includes("small local router")) {
    throw new Error(`the summary was ${text}`);
  }
  if (text.includes("Opened") || text.includes("Chrome")) {
    throw new Error(`the reply claimed the page opened: ${text}`);
  }
  if (!fetched.some((url) => url.includes("/abs/2609.09153"))) {
    throw new Error(`fetched ${fetched.join(" | ")}`);
  }
  if (opened.length !== 0) {
    throw new Error(`chrome opened ${opened.join(" | ")}`);
  }
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  app.close();
}
