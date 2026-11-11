import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { installBridge } from "./bridge.ts";
import { startHost } from "./host-client.ts";

const pages = [
  "index.html",
  "chat.html",
  "approvals.html",
  "activity.html",
  "capabilities.html",
  "builder.html",
  "memory.html",
  "mail.html",
] as const;

const out = join(import.meta.dir, "../artifacts/ui-screenshots");
mkdirSync(out, { recursive: true });

const host = await startHost();
await host.call("memory_remember", { text: "the revenue total is 220" });
await host.call("builder_install", {
  prompt: "show total revenue as a big number",
});

const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"] as const) {
    for (const file of pages) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      try {
        await installBridge(page, host);
        await page.addInitScript((choice) => {
          localStorage.setItem("pa-theme", choice);
        }, theme);
        await page.goto(
          pathToFileURL(join(import.meta.dir, "../apps/desktop/ui", file)).href,
        );
        await waitForPage(file);
        const applied = await page.locator("html").getAttribute("data-theme");
        if (applied !== theme) {
          throw new Error(`${file} theme was ${String(applied)}`);
        }
        const name = file.replace(".html", "");
        await page.screenshot({
          path: join(out, `${name === "index" ? "home" : name}-${theme}.png`),
          fullPage: true,
        });

        async function waitForPage(current: string): Promise<void> {
          if (current === "index.html") {
            await page.getByText("220", { exact: true }).waitFor();
            return;
          }
          if (current === "chat.html") {
            await page.waitForFunction(() => {
              const notice = document.getElementById("model-notice");
              return (
                notice !== null && !notice.textContent?.startsWith("Checking")
              );
            });
            return;
          }
          if (current === "approvals.html") {
            await page.getByRole("heading", { name: /install/i }).waitFor();
            return;
          }
          if (current === "activity.html") {
            await page.locator("#activity li").first().waitFor();
            return;
          }
          if (current === "capabilities.html") {
            await page.getByRole("heading", { name: "Hello" }).waitFor();
            return;
          }
          if (current === "builder.html") {
            await page.getByRole("button", { name: /Total/ }).click();
            await page.getByRole("heading", { name: "Review" }).waitFor();
            return;
          }
          if (current === "memory.html") {
            await page.getByText("the revenue total is 220").waitFor();
            return;
          }
          await page
            .locator("#digest")
            .getByText("Budget notes", { exact: true })
            .waitFor();
        }
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await host.stop();
}
