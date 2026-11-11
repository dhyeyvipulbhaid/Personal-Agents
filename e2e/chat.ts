import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { Approvals } from "../packages/host/src/approvals/approvals.ts";
import {
  type ChatRequest,
  type ModelAdapter,
  ModelSettings,
} from "../packages/host/src/models/adapter.ts";
import { ChatSession } from "../packages/host/src/models/chat.ts";

const catalog = [
  { name: "llama", tools: true, streaming: true, structured: true },
  { name: "plain", tools: false, streaming: true, structured: false },
  { name: "llama-next", tools: true, streaming: true, structured: true },
];
const settings = new ModelSettings();
settings.set("chat", "llama", catalog);
settings.set("agent", "llama", catalog);
settings.set("builder", "llama", catalog);
const approvals = new Approvals(() => {});
const adapter: ModelAdapter = {
  async listModels() {
    return catalog;
  },
  async chat(request: ChatRequest, onDelta) {
    onDelta({ token: "from " });
    onDelta({ token: request.model });
    if (request.messages.at(-1)?.content === "approve this") {
      return {
        text: `from ${request.model}`,
        toolCall: { name: "delete the row", arguments: "delete row 1" },
      };
    }
    return { text: `from ${request.model}` };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};
const session = new ChatSession(adapter, settings, approvals);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.exposeFunction(
    "hostInvoke",
    async (command: string, args?: Record<string, string>) => {
      if (command === "chat_state") {
        return JSON.stringify(session.messages);
      }
      if (command === "chat_send") {
        await session.send(String(args?.text ?? ""));
        return JSON.stringify(session.messages);
      }
      if (command === "chat_approve") {
        session.approveInline(String(args?.id ?? ""));
        return JSON.stringify(session.messages);
      }
      if (command === "set_models") {
        settings.set("chat", String(args?.chat ?? ""), catalog);
        settings.set("agent", String(args?.agent ?? ""), catalog);
        settings.set("builder", String(args?.builder ?? ""), catalog);
        return "ok";
      }
      if (command === "list_models") {
        return JSON.stringify({
          running: true,
          models: catalog,
          selected: {
            chat: settings.get("chat"),
            agent: settings.get("agent"),
            builder: settings.get("builder"),
          },
          missing: [],
          notice: "",
        });
      }
      if (command === "ollama_status") {
        return "running";
      }
      if (
        command === "chat_stop" ||
        command === "chat_new" ||
        command === "chat_open"
      ) {
        return JSON.stringify(session.messages);
      }
      if (command === "approvals") {
        return JSON.stringify(approvals.pending());
      }
      throw new Error(`unexpected command ${command}`);
    },
  );
  await page.addInitScript(() => {
    const host = window as unknown as {
      hostInvoke: (command: string, args?: unknown) => Promise<string>;
    };
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke: (command: string, args?: unknown) =>
            host.hostInvoke(command, args),
        },
      },
    });
  });

  const home = pathToFileURL(
    join(import.meta.dir, "../apps/desktop/ui/index.html"),
  ).href;
  await page.goto(home);
  await page.locator("#theme").waitFor();
  await page.keyboard.press("Alt+c");
  await page.waitForURL(/chat\.html$/);
  await page.locator("#draft").fill("hello");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".bubble.assistant", { hasText: "from llama" }).waitFor();

  await page.locator("#chat-model").selectOption("llama-next");
  await page.getByRole("button", { name: "Save models" }).click();
  await page.getByText("Saved").waitFor();
  const savedClass = await page.locator("#model-error").getAttribute("class");
  if (!savedClass?.split(/\s+/).includes("ok")) {
    throw new Error(`Saved used class ${savedClass}`);
  }
  await page.locator("#draft").fill("again");
  await page.getByRole("button", { name: "Send" }).click();
  await page
    .locator(".bubble.assistant", { hasText: "from llama-next" })
    .waitFor();

  await page.locator("#agent-model").selectOption("plain");
  await page.getByRole("button", { name: "Save models" }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("model-error")
      ?.textContent?.toLowerCase()
      .includes("tool"),
  );

  await page.locator("#draft").fill("approve this");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  const status = page.locator(".approval-status", {
    hasText: "delete the row",
  });
  await status.waitFor();
  const answer = page.locator(".bubble.assistant").last();
  const statusBox = await status.boundingBox();
  const answerBox = await answer.boundingBox();
  if (!statusBox || !answerBox || statusBox.y >= answerBox.y) {
    throw new Error("the approval status rendered below the answer");
  }
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/approvals.html"))
      .href,
  );
  await page.getByText("No waiting requests").waitFor();
} finally {
  await browser.close();
}
