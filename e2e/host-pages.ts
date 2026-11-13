import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
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
];

const nav = pages;

const host = await startHost();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await installBridge(page, host);
  await open(page, "index.html");
  await page.frameLocator("iframe.widget-frame").locator("#greeting").waitFor();
  await page.getByText("220", { exact: true }).waitFor();
  await assertNoUnavailable(page, "home");
  const homeNav = await navHrefs(page);

  await open(page, "mail.html");
  await page
    .locator("#digest")
    .getByText("Budget notes", { exact: true })
    .waitFor();
  await page
    .locator("#follow-ups")
    .getByText("North contract", { exact: true })
    .waitFor();
  await assertNoUnavailable(page, "mail");

  await open(page, "chat.html");
  await page.locator("#chat-model").waitFor();
  const chat = (await page.locator("body").textContent()) ?? "";
  if (!chat.includes("qwen3:8b")) {
    throw new Error(`chat did not show the v1 model\n${chat}`);
  }
  if (
    (chat.includes("not running") || chat.includes("not installed")) &&
    !chat.includes("ollama pull qwen3:8b")
  ) {
    throw new Error(`chat did not explain how to get the model\n${chat}`);
  }
  await assertNoUnavailable(page, "chat");

  await open(page, "capabilities.html");
  await page
    .locator("#checks")
    .getByText(/ollama/i)
    .first()
    .waitFor();
  const capabilities = (await page.locator("body").textContent()) ?? "";
  if (!/Ready|Blocked/.test(capabilities)) {
    throw new Error(`capabilities had no probe result\n${capabilities}`);
  }
  await assertNoUnavailable(page, "capabilities");

  await open(page, "builder.html");
  const steps = page.locator("#builder-steps");
  await steps.getByText("Draft", { exact: true }).waitFor();
  await steps.getByText("Generate", { exact: true }).waitFor();
  await steps.getByText("Check", { exact: true }).waitFor();
  await steps.getByText("Install", { exact: true }).waitFor();
  await assertNoUnavailable(page, "builder");

  await open(page, "memory.html");
  await page.getByRole("heading", { name: "Memory" }).waitFor();
  await assertNoUnavailable(page, "memory");

  await open(page, "activity.html");
  await page.locator("#activity").waitFor();
  await assertNoUnavailable(page, "activity");

  await open(page, "approvals.html");
  await page.getByRole("heading", { name: "Approvals" }).waitFor();
  await assertNoUnavailable(page, "approvals");

  for (const file of pages) {
    await open(page, file);
    const hrefs = await navHrefs(page);
    if (hrefs.join() !== nav.join() || hrefs.join() !== homeNav.join()) {
      throw new Error(`${file} nav was ${hrefs.join(", ")}`);
    }
    await assertNoUnavailable(page, file);
  }
} finally {
  await browser.close();
  await host.stop();
}

async function open(page: Page, file: string): Promise<void> {
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui", file)).href,
  );
}

async function navHrefs(page: Page): Promise<string[]> {
  return page
    .locator("nav a")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") ?? ""),
    );
}

async function assertNoUnavailable(page: Page, name: string): Promise<void> {
  const text = (await page.locator("body").textContent()) ?? "";
  if (/\bunavailable\b/i.test(text)) {
    throw new Error(`${name} rendered an unavailable state\n${text}`);
  }
}
