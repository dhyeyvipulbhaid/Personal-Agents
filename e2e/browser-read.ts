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
  const url = String(input);
  if (url.includes("apple.com")) {
    return new Response(
      "<title>Apple</title><main><p>Live store text</p></main>",
    );
  }
  if (url.includes("example.com")) {
    return new Response(story);
  }
  return originalFetch(input, init);
}) as typeof fetch;

const seen: ChatRequest[] = [];
let releaseAnswer = () => {};
let markAnswer = () => {};
const answerStarted = new Promise<void>((resolve) => {
  markAnswer = resolve;
});
const answerGate = new Promise<void>((resolve) => {
  releaseAnswer = resolve;
});
let releaseApple = () => {};
let markApple = () => {};
const appleStarted = new Promise<void>((resolve) => {
  markApple = resolve;
});
const appleGate = new Promise<void>((resolve) => {
  releaseApple = resolve;
});
let releaseNamed = () => {};
let markNamed = () => {};
const namedStarted = new Promise<void>((resolve) => {
  markNamed = resolve;
});
const namedGate = new Promise<void>((resolve) => {
  releaseNamed = resolve;
});
let appleReads = 0;
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
    const pageText = request.messages
      .map((message) => message.content)
      .join("\n");
    if (pageText.includes("Live store text")) {
      appleReads += 1;
      if (appleReads === 1) {
        markApple();
        await appleGate;
        return {
          text: "The Apple website is open and displays a range of products.",
        };
      }
      markNamed();
      await namedGate;
      const notes =
        request.messages.find((message) =>
          message.content.startsWith("Page notes from"),
        )?.content ?? pageText;
      return {
        text: `${notes}\nVisit apple.com for more information.`,
      };
    }
    if (pageText.includes("illustrative examples in documents")) {
      markAnswer();
      await answerGate;
      return {
        text: "Example Domain says this domain is for use in illustrative examples in documents.",
      };
    }
    return { text: "The tool did not return the page text." };
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
  await page.getByText("Waiting for approval…").waitFor();
  await page.getByRole("link", { name: "Review" }).waitFor();
  if ((await page.getByRole("button", { name: "Send" }).count()) !== 0) {
    throw new Error("Send was active while approval was pending");
  }
  if (
    (await page
      .locator(".approval-status", { hasText: "Read example.com" })
      .count()) !== 0
  ) {
    throw new Error("the read looked finished before it was approved");
  }
  await approve.click();
  await page
    .locator(".approval-status", { hasText: "Read example.com" })
    .waitFor();
  await answerStarted;
  await page
    .locator("[data-thinking]", { hasText: "Writing answer…" })
    .waitFor();
  const send = page.locator("#send-button");
  const label = (await send.textContent())?.trim();
  if (label === "Send" && !(await send.isDisabled())) {
    throw new Error("Send was active while the answer was still generating");
  }
  releaseAnswer();
  await page
    .locator(".bubble.assistant", {
      hasText: "illustrative examples in documents",
    })
    .waitFor();
  if ((await page.locator("[data-thinking]").count()) !== 0) {
    throw new Error("Thinking stayed after the answer");
  }
  await page.getByRole("button", { name: "Send" }).waitFor();
  if (await page.locator("#send-button").isDisabled()) {
    throw new Error("Send stayed disabled after the answer");
  }

  await page.locator("#draft").fill("What is on the apple.com homepage?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  const read = page.locator(".approval-status", { hasText: "Read apple.com" });
  await read.waitFor();
  await appleStarted;
  const thinking = page.locator("[data-thinking]", {
    hasText: "Writing answer…",
  });
  await thinking.waitFor();
  if ((await page.getByRole("button", { name: "Send" }).count()) !== 0) {
    throw new Error("Send was active while the answer was still generating");
  }
  await page.getByRole("button", { name: "Stop" }).waitFor();
  const readBox = await read.boundingBox();
  const thinkingBox = await thinking.boundingBox();
  if (!readBox || !thinkingBox || readBox.y >= thinkingBox.y) {
    throw new Error("Thinking was not under the read line");
  }
  releaseApple();
  const answer = page.locator(".bubble.assistant").last();
  await answer.getByRole("link", { name: "apple.com" }).waitFor();
  const shown = await answer.innerText();
  if (/\bopen(?:ed)?\b/i.test(shown)) {
    throw new Error(`the answer claimed the site was open: ${shown}`);
  }
  if ((await page.locator("[data-thinking]").count()) !== 0) {
    throw new Error("Thinking stayed after the page answer");
  }
  if ((await page.getByRole("button", { name: "Approve" }).count()) !== 0) {
    throw new Error("a second approval was still waiting");
  }
  await page.getByRole("button", { name: "Send" }).waitFor();

  await page.locator("#draft").fill("Read apple.com");
  await page.getByRole("button", { name: "Send" }).click();
  const named = page
    .locator(".approval-status", { hasText: "Read apple.com" })
    .last();
  await named.waitFor();
  await namedStarted;
  const writing = page.locator("[data-thinking]", {
    hasText: "Writing answer…",
  });
  await writing.waitFor();
  if ((await page.getByRole("button", { name: "Send" }).count()) !== 0) {
    throw new Error("Send was active while the named read was still writing");
  }
  const namedBox = await named.boundingBox();
  const writingBox = await writing.boundingBox();
  if (!namedBox || !writingBox || namedBox.y >= writingBox.y) {
    throw new Error("Writing answer was not under the read line");
  }
  releaseNamed();
  const summary = page.locator(".bubble.assistant").last();
  await summary.getByRole("link", { name: "apple.com" }).waitFor();
  const summaryText = await summary.innerText();
  if (!summaryText.includes("couldn't summarize")) {
    throw new Error(`the page was pasted: ${summaryText}`);
  }
  if (summaryText.includes("Live store text")) {
    throw new Error("the answer included the raw page");
  }
} finally {
  releaseAnswer();
  releaseApple();
  releaseNamed();
  globalThis.fetch = originalFetch;
  await browser.close();
  app.close();
}
