import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type { ModelAdapter } from "../packages/host/src/models/adapter.ts";

let calls = 0;
const adapter: ModelAdapter = {
  async listModels() {
    return [
      { name: "qwen3:8b", tools: true, streaming: true, structured: true },
    ];
  },
  async chat(request) {
    calls += 1;
    const text =
      request.messages.filter((message) => message.role === "user").at(-1)
        ?.content ?? "";
    if (
      request.tools &&
      request.tools.length > 0 &&
      text.includes("navigate")
    ) {
      return {
        text: "",
        toolCall: {
          name: "browser.navigate",
          arguments: JSON.stringify({ url: "https://example.com" }),
        },
      };
    }
    return { text: "Done." };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const waits: (() => void)[] = [];
let navigated = 0;

async function releaseHeld() {
  const started = Date.now();
  while (waits.length === 0) {
    if (Date.now() - started > 3_000) {
      throw new Error("the host call was not held");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  waits.shift()?.();
}

const dir = mkdtempSync(join(tmpdir(), "pa-home-browser-"));
const app = new DesktopApp({
  dataDir: dir,
  adapter,
  probe: async () => "running",
  memoryExtractor: { extract: () => [] },
  chromePath: "chrome",
  browserConnect: async () => {
    let href = "about:blank";
    return {
      async send(method: string, params?: Record<string, unknown>) {
        if (method === "Page.navigate") {
          navigated += 1;
          href = String(params?.url ?? href);
          return {};
        }
        if (method === "Page.captureScreenshot") {
          const clip = params?.clip as { width?: number } | undefined;
          if (
            params?.format !== "jpeg" ||
            params?.quality !== 40 ||
            clip?.width !== 480
          ) {
            throw new Error(`thumbnail params ${JSON.stringify(params)}`);
          }
          return { data: "abc" };
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          if (expression.includes("visibilityState")) {
            return {
              result: {
                value: JSON.stringify({ href, state: "visible" }),
              },
            };
          }
          return { result: { value: "complete" } };
        }
        return {};
      },
      async close() {},
    };
  },
});
await app.start();
const methods = app.methods();

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
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
      if (command === "chat_approve" || command === "browser_stop") {
        await new Promise<void>((resolve) => {
          waits.push(resolve);
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
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/index.html")).href,
  );
  await page
    .locator("#browser-idle", { hasText: "No browser activity yet." })
    .waitFor();

  const send = Promise.resolve(
    methods.chat_send({ text: "navigate to the sign in page" }),
  );
  await page.locator("#browser-pending").waitFor();
  await page.getByRole("button", { name: "Deny" }).click();
  await page.locator("#browser-status", { hasText: "Denied" }).waitFor();
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("approve stayed clickable");
  }
  await releaseHeld();
  await send;
  await page.locator("#browser-idle").waitFor();

  const again = Promise.resolve(
    methods.chat_send({ text: "navigate to example.com" }),
  );
  await page.getByRole("button", { name: "Approve" }).waitFor();
  await methods.chat_approve({
    id:
      (JSON.parse(await methods.approvals({})) as { id: string }[])[0]?.id ??
      "",
    action: "approve",
  });
  await again;
  await page.locator(".browser-thumb").waitFor();
  const src = await page.locator(".browser-thumb").getAttribute("src");
  if (!src?.includes("abc")) {
    throw new Error(`thumbnail was ${src}`);
  }
  await page.locator("#browser-site", { hasText: "example.com" }).waitFor();
  const stop = page.getByRole("button", { name: "Stop" });
  await stop.click();
  await page.getByRole("button", { name: "Stopping…" }).waitFor();
  await releaseHeld();
  await page.locator("#browser-idle").waitFor();
  if (calls < 2) {
    throw new Error("the model was not asked to navigate");
  }

  const navigatedBeforeRead = navigated;
  const originalFetch = globalThis.fetch;
  let releaseFetch: (() => void) | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("example.com")) {
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the read was not stopped")),
          8_000,
        );
        const fail = () => {
          clearTimeout(timer);
          const error = new Error("Stopped.");
          error.name = "AbortError";
          reject(error);
        };
        releaseFetch = fail;
        init?.signal?.addEventListener("abort", fail, { once: true });
      });
      return new Response(
        "<title>Example</title><main><p>Example Domain</p></main>",
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const question = Promise.resolve(
      methods.chat_send({ text: "What is on the example.com homepage?" }),
    );
    await page.locator("#browser-pending").waitFor();
    await page.locator("#browser-site", { hasText: "example.com" }).waitFor();
    await page
      .locator("#browser-step", { hasText: "Reading example.com" })
      .waitFor();
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Stopping…" }).waitFor();
    await releaseHeld();
    await page.locator("#browser-idle").waitFor();
    await question;
    if (navigated !== navigatedBeforeRead) {
      throw new Error("a background read focused Chrome");
    }
  } finally {
    releaseFetch?.();
    globalThis.fetch = originalFetch;
  }
} finally {
  waits.shift()?.();
  await browser.close();
  app.close();
}
