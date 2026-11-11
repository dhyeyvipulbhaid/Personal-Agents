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
    if (seen.length === 1) {
      return {
        text: "I don't have access to your files.",
        toolCall: { name: "revenue.read", arguments: "{}" },
      };
    }
    return {
      text: "The total in revenue.csv is 220 (North 100, South 80, West 40).",
    };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const dir = mkdtempSync(join(tmpdir(), "pa-host-tools-"));
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
  await page.locator("#draft").fill("What's the total in revenue.csv?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".bubble.assistant", { hasText: "220" }).waitFor();
  const reply = await page.locator(".bubble.assistant").textContent();
  if (
    !reply?.includes("North 100") ||
    !reply.includes("South 80") ||
    !reply.includes("West 40")
  ) {
    throw new Error(`reply was ${String(reply)}`);
  }
  if (seen[0]?.model !== "qwen3:8b") {
    throw new Error(`model was ${String(seen[0]?.model)}`);
  }
  if (!seen[0]?.tools?.some((tool) => tool.function.name === "revenue.read")) {
    throw new Error("revenue.read was not offered");
  }
} finally {
  await browser.close();
  app.close();
}
