import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke(command: string) {
            if (command === "host_version") {
              return Promise.resolve("0.0.0");
            }
            if (command === "note_displayed_host_version") {
              return Promise.resolve(null);
            }
            if (command === "widgets") {
              return Promise.resolve("[]");
            }
            if (command === "ollama_status") {
              return Promise.resolve("stopped");
            }
            return Promise.reject(new Error(`unexpected command ${command}`));
          },
        },
      },
    });
  });
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/index.html")).href,
  );
  const status = page.locator("#ollama-status");
  await status.getByRole("link", { name: "Install Ollama" }).waitFor();
  const href = await status.locator("a").getAttribute("href");
  if (href !== "https://ollama.com/download") {
    throw new Error(`ollama link was ${String(href)}`);
  }
  const text = await status.textContent();
  if (!text?.includes("Ollama is not running")) {
    throw new Error(`ollama status was ${String(text)}`);
  }
} finally {
  await browser.close();
}
