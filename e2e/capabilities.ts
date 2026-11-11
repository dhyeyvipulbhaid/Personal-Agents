import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { probeCapabilities } from "../packages/host/src/capabilities/probe.ts";

const checks = probeCapabilities({
  folders: [{ path: "/data", readable: true }],
  browsers: [{ name: "Chrome", installed: true }],
  policies: [{ key: "RemoteDebuggingAllowed", value: "false" }],
  ollamaPortOpen: true,
  models: ["llama"],
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript((payload) => {
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke(command: string) {
            if (command === "capabilities") {
              return Promise.resolve(JSON.stringify(payload));
            }
            return Promise.reject(new Error(command));
          },
        },
      },
    });
  }, checks);
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/capabilities.html"))
      .href,
  );
  await page.getByText("Remote debugging").waitFor();
  await page.getByText("RemoteDebuggingAllowed", { exact: true }).waitFor();
  await page.getByText("Blocked").first().waitFor();
} finally {
  await browser.close();
}
