import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import { ChatMemory } from "../packages/host/src/memory/chat-memory.ts";
import type { ModelAdapter } from "../packages/host/src/models/adapter.ts";

const facts = [
  "The civic archive is now open in the user's browser.",
  "The user attempted to navigate to portal.invalid, but the assistant stopped the action.",
  "The assistant opened portal.invalid in Chrome.",
];
const reply =
  "I have successfully opened the civic archive. Let me know if there's anything specific you'd like to explore or look up!";
const question =
  "Navigate to the civic archive and tell me what opened in Chrome.";

function pageUrl(file: string): string {
  return pathToFileURL(join(import.meta.dir, "../apps/desktop/ui", file)).href;
}

async function installBridge(
  page: Page,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
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
      return invoke(command, args);
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

async function assertThreadHidesFacts(page: Page): Promise<void> {
  await page
    .locator(".bubble.assistant", { hasText: reply })
    .waitFor({ timeout: 5000 });
  const notes = await page.locator(".memory-note").count();
  if (notes !== 0) {
    throw new Error(`chat rendered ${notes} memory fact notes`);
  }
  const thread = (await page.locator("#thread").textContent()) ?? "";
  if (thread.includes("(source ")) {
    throw new Error(`chat thread still shows a source label:\n${thread}`);
  }
  for (const fact of facts) {
    if (thread.includes(fact)) {
      throw new Error(`chat thread still shows a memory fact:\n${thread}`);
    }
  }
  const assistant =
    (await page.locator(".bubble.assistant").textContent()) ?? "";
  if (assistant !== reply) {
    throw new Error(`assistant reply changed:\n${assistant}`);
  }
}

async function assertMemoryPageListsFacts(page: Page): Promise<void> {
  await page.goto(pageUrl("memory.html"));
  for (const fact of facts) {
    await page.getByText(`${fact} (source chat)`).waitFor({ timeout: 5000 });
  }
}

const browser = await chromium.launch();
try {
  const leaked = await browser.newPage();
  const stored = facts.map((text, index) => ({
    id: `fact-${index + 1}`,
    text,
    source: "chat",
  }));
  await installBridge(leaked, async (command) => {
    if (command === "ollama_status") {
      return "stopped";
    }
    if (command === "approvals") {
      return "[]";
    }
    if (command === "list_models") {
      return JSON.stringify({
        running: false,
        models: [],
        selected: {},
        missing: [],
        notice: "",
      });
    }
    if (command === "chat_state" || command === "chat_open") {
      return JSON.stringify({
        messages: [
          { role: "user", text: question },
          { role: "assistant", text: reply },
          ...facts.map((text) => ({
            role: "memory",
            text: `${text} (source chat)`,
          })),
        ],
        sessions: [{ id: "session-1", title: "Civic archive" }],
        activeId: "session-1",
        streaming: false,
        models: null,
        notice: "",
      });
    }
    if (command === "memory_list") {
      return JSON.stringify(stored);
    }
    throw new Error(`unexpected command ${command}`);
  });
  await leaked.goto(pageUrl("chat.html"));
  await assertThreadHidesFacts(leaked);
  await assertMemoryPageListsFacts(leaked);

  const dir = mkdtempSync(join(tmpdir(), "pa-chat-memory-facts-"));
  const memory = new ChatMemory({
    dataDir: dir,
    extractor: { extract: () => [] },
  });
  for (const fact of facts) {
    await memory.remember(fact);
  }
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    async chat() {
      return { text: reply };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const app = new DesktopApp({
    dataDir: dir,
    adapter,
    probe: async () => "stopped",
    memory,
  });
  await app.start();
  const methods = app.methods();
  const live = await browser.newPage();
  try {
    await installBridge(live, async (command, args) => {
      if (command === "ollama_status") {
        return methods.ollama({});
      }
      const method = methods[command];
      if (!method) {
        throw new Error(`unexpected command ${command}`);
      }
      return method(args ?? {});
    });
    await live.goto(pageUrl("chat.html"));
    await live.locator("#draft").fill(question);
    await live.getByRole("button", { name: "Send" }).click();
    await assertThreadHidesFacts(live);
    await assertMemoryPageListsFacts(live);
  } finally {
    app.close();
  }
} finally {
  await browser.close();
}
