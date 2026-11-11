import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DesktopApp } from "../packages/host/src/desktop.ts";
import type { ModelAdapter } from "../packages/host/src/models/adapter.ts";

const adapter: ModelAdapter = {
  async listModels() {
    return [];
  },
  async chat() {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { text: "Thanks for the note." };
  },
  async structured<T>(): Promise<T> {
    return {} as T;
  },
};

const app = new DesktopApp({
  dataDir: mkdtempSync(join(tmpdir(), "pa-mail-draft-")),
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
      if (
        command === "note_displayed_host_version" ||
        command === "host_version"
      ) {
        return command === "host_version" ? "0.0.0" : null;
      }
      if (command === "audit_log") {
        return "[]";
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
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/mail.html")).href,
  );
  const row = page.locator("#messages li").first();
  const draft = row.getByRole("button", { name: "Draft reply" });
  await draft.click();
  await row.getByRole("button", { name: "Drafting…" }).waitFor();
  const waiting = row.getByRole("button", {
    name: "Draft waiting in Approvals",
  });
  await waiting.waitFor();
  await row.locator("a[href='approvals.html']").waitFor();
  await waiting.click({ force: true });
  const pending = JSON.parse(
    await page.evaluate(() => {
      const bridge = window as unknown as {
        hostInvoke: (command: string) => Promise<string>;
      };
      return bridge.hostInvoke("approvals");
    }),
  ) as unknown[];
  if (pending.length !== 1) {
    throw new Error(`approvals length ${pending.length}`);
  }
} finally {
  await browser.close();
  app.close();
}
