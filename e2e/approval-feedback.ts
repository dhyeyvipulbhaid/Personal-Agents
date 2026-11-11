import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type { ModelAdapter } from "../packages/host/src/models/adapter.ts";

let releaseModel = () => {};
const modelHeld = new Promise<void>((resolve) => {
  releaseModel = resolve;
});
let releaseApprove = () => {};
let markApprove = () => {};
const approveHeld = new Promise<void>((resolve) => {
  markApprove = resolve;
});

const adapter: ModelAdapter = {
  async listModels() {
    return [
      { name: "qwen3:8b", tools: true, streaming: true, structured: true },
    ];
  },
  async chat(request) {
    const text =
      request.messages.filter((message) => message.role === "user").at(-1)
        ?.content ?? "";
    if (
      request.tools &&
      request.tools.length > 0 &&
      text.includes("example.com")
    ) {
      await modelHeld;
      return {
        text: "",
        toolCall: {
          name: "browser.open",
          arguments: JSON.stringify({ url: "https://example.com" }),
        },
      };
    }
    return { text: "The page says Example Domain." };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const dir = mkdtempSync(join(tmpdir(), "pa-approval-feedback-"));
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
      if (command === "chat_approve") {
        await new Promise<void>((resolve) => {
          releaseApprove = resolve;
          markApprove();
        });
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
    .fill("Open example.com and tell me what the page says.");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator("[data-thinking]").waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("the card appeared before the model answered");
  }
  releaseModel();
  await page.getByRole("button", { name: "Approve" }).waitFor();
  if ((await page.locator("[data-thinking]").count()) !== 0) {
    throw new Error("Thinking stayed after the card");
  }
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Opening example.com…").waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("approve stayed clickable");
  }
  if ((await page.getByRole("button", { name: "Deny" }).count()) !== 0) {
    throw new Error("deny stayed clickable");
  }
  await approveHeld;
  releaseApprove();
  await page
    .locator(".bubble.assistant", { hasText: "Example Domain" })
    .waitFor();
} finally {
  releaseModel();
  releaseApprove();
  await browser.close();
  app.close();
}
