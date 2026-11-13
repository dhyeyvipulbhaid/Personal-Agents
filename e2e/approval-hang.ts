import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type { ModelAdapter } from "../packages/host/src/models/adapter.ts";
import type { RpcMethods } from "../packages/host/src/rpc.ts";

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
    if (request.tools && request.tools.length > 0 && /apple/i.test(text)) {
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

function host(): DesktopApp {
  return new DesktopApp({
    dataDir: mkdtempSync(join(tmpdir(), "pa-approval-hang-")),
    adapter,
    probe: async () => "running",
    memoryExtractor: { extract: () => [] },
    chromePath: "chrome",
    browserConnect: async () => ({
      async send(method: string) {
        if (method === "Page.navigate" || method === "Runtime.evaluate") {
          return new Promise(() => {});
        }
        return {};
      },
      async close() {},
    }),
  });
}

const pressApp = host();
const slowApp = host();
await pressApp.start();
await slowApp.start();
const releases: (() => void)[] = [];

async function wire(
  page: Page,
  methods: RpcMethods,
  mode: "reject" | "hold",
): Promise<void> {
  await page.exposeFunction(
    "hostInvoke",
    async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "note_displayed_host_version" ||
        command === "audit_log"
      ) {
        return command === "audit_log" ? "[]" : null;
      }
      if (command === "host_version") {
        return "0.0.0";
      }
      if (command === "ollama_status") {
        return methods.ollama({});
      }
      if (command === "chat_send" && mode === "reject") {
        const real = Promise.resolve(methods.chat_send(args ?? {}));
        real.catch(() => {});
        return await new Promise((resolve, reject) => {
          releases.push(() => reject(new Error("agent host timed out")));
          real.then(resolve, reject);
        });
      }
      if (command === "chat_approve") {
        return await new Promise((resolve, reject) => {
          releases.push(() => {
            if (mode === "reject") {
              reject(new Error("agent host timed out"));
              return;
            }
            resolve(methods.chat_approve(args ?? {}));
          });
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
}

const chatUrl = pathToFileURL(
  join(import.meta.dir, "../apps/desktop/ui/chat.html"),
).href;

const browser = await chromium.launch();
try {
  const press = await browser.newPage();
  await wire(press, pressApp.methods(), "hold");
  await press.goto(chatUrl);
  await press.locator("#draft").fill("Navigate to https://www.apple.com");
  await press.getByRole("button", { name: "Send" }).click();
  await press.getByRole("button", { name: "Approve" }).waitFor();
  await press
    .getByRole("button", { name: "Approve" })
    .dispatchEvent("mousedown");
  await press.waitForTimeout(400);
  if ((await press.getByText("Opening www.apple.com…").count()) !== 1) {
    throw new Error("pressing Approve did not lock the card");
  }
  if ((await press.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("approve stayed clickable after the press");
  }
  await press.reload();
  await press.getByText("Opening www.apple.com…").waitFor({ timeout: 5_000 });
  if ((await press.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("a reload restored Approve");
  }

  const slowContext = await browser.newContext();
  const slow = await slowContext.newPage();
  await wire(slow, slowApp.methods(), "reject");
  await slow.goto(chatUrl);
  await slow.locator("#draft").fill("Navigate to https://www.apple.com");
  await slow.getByRole("button", { name: "Send" }).click();
  await slow.getByRole("button", { name: "Approve" }).waitFor();
  await slow.getByRole("button", { name: "Approve" }).click();
  await slow.getByText("Opening www.apple.com…").waitFor();
  if (releases.length < 2) {
    throw new Error("the approve click did not reach the host");
  }
  for (const release of releases.splice(0)) {
    release();
  }
  await slow.waitForTimeout(400);
  const body = (await slow.locator("body").textContent()) ?? "";
  if (body.includes("Quit Personal Agents")) {
    throw new Error(`a slow navigate showed the fatal banner:\n${body}`);
  }
  if ((await slow.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("a timed-out reply restored Approve");
  }
  if ((await slow.getByText("Opening www.apple.com…").count()) !== 1) {
    throw new Error("the Opening status disappeared after the timeout");
  }
} finally {
  for (const release of releases) {
    release();
  }
  await browser.close();
  pressApp.close();
  slowApp.close();
}
