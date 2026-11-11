import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const facts: { id: string; text: string; source: string }[] = [];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.exposeFunction(
    "hostInvoke",
    async (command: string, args?: { text?: string; id?: string }) => {
      if (command === "ollama_status") {
        return "stopped";
      }
      if (command === "approvals") {
        return "[]";
      }
      if (command === "host_version") {
        return "0.0.0";
      }
      if (command === "note_displayed_host_version") {
        return null;
      }
      if (command === "memory_list") {
        return JSON.stringify(facts);
      }
      if (command === "memory_remember") {
        facts.push({
          id: "fact-1",
          text: String(args?.text ?? ""),
          source: "memory",
        });
        return JSON.stringify(facts[0]);
      }
      throw new Error(`unexpected command ${command}`);
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
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/memory.html")).href,
  );
  await page.locator("#fact").fill("the revenue total is 220");
  await page.getByRole("button", { name: "Save fact" }).click();
  await page.getByText("the revenue total is 220 (source memory)").waitFor();
  const status = await page.locator("#memory-status").textContent();
  if (status?.includes("did not load")) {
    throw new Error(status);
  }
} finally {
  await browser.close();
}
