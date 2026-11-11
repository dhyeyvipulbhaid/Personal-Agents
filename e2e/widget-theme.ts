import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { HELLO_PLUGIN_SOURCE } from "../packages/host/src/plugins/hello.ts";
import { PluginKernel } from "../packages/host/src/plugins/kernel.ts";

const kernel = new PluginKernel();
await kernel.load(HELLO_PLUGIN_SOURCE);
const widgets = kernel.tiles().map((tile) => ({
  id: tile.id,
  title: tile.title,
  html: tile.html,
}));
kernel.unload("hello");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript((payload) => {
    localStorage.removeItem("pa-theme");
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
              return Promise.resolve(JSON.stringify(payload));
            }
            return Promise.reject(new Error(`unexpected command ${command}`));
          },
        },
      },
    });
  }, widgets);

  const pageUrl = pathToFileURL(
    join(import.meta.dir, "../apps/desktop/ui/index.html"),
  ).href;
  await page.goto(pageUrl);

  const frame = page.locator("iframe.widget-frame");
  await frame.waitFor();
  const sandbox = await frame.getAttribute("sandbox");
  if (sandbox !== "") {
    throw new Error(`widget frame sandbox was ${String(sandbox)}`);
  }
  const greeting = page
    .frameLocator("iframe.widget-frame")
    .locator("#greeting");
  await greeting.waitFor();
  const text = await greeting.textContent();
  if (text !== "Hello") {
    throw new Error(`greeting was ${String(text)}`);
  }

  await page.locator("#theme").selectOption("dark");
  await expectTheme(page, "dark");
  await page.locator("#theme").selectOption("light");
  await expectTheme(page, "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("#theme").selectOption("system");
  await expectTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
} finally {
  await browser.close();
}

async function expectTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const deadline = Date.now() + 2_000;
  let shell: string | null = null;
  let srcdoc: string | null = null;
  let frameTheme: string | null = null;
  while (Date.now() < deadline) {
    shell = await page.locator("html").getAttribute("data-theme");
    srcdoc = await page.locator("iframe.widget-frame").getAttribute("srcdoc");
    frameTheme = await page
      .frameLocator("iframe.widget-frame")
      .locator("html")
      .getAttribute("data-theme");
    if (
      shell === theme &&
      srcdoc?.includes(`data-theme="${theme}"`) &&
      frameTheme === theme
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `theme stayed page=${String(shell)} frame=${String(frameTheme)}`,
  );
}
