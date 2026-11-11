import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { decide } from "../packages/host/src/broker/broker.ts";
import { defaultPolicy } from "../packages/host/src/broker/policy.ts";

const outside = decide(
  {
    pluginId: "files",
    capability: "files.read",
    scope: "/data/other/secret.csv",
    grants: [
      { capability: "files.read", scope: "/data/granted", decision: "always" },
    ],
  },
  defaultPolicy,
  new Date("2026-11-11T00:00:01.000Z"),
);
const policy = decide(
  {
    pluginId: "mail",
    capability: "connectors.use",
    scope: "mail-remote",
    grants: [
      { capability: "connectors.use", scope: "mail-remote", decision: "allow" },
    ],
  },
  defaultPolicy,
  new Date("2026-11-11T00:00:03.000Z"),
);
const deletes = decide(
  {
    pluginId: "files",
    capability: "files.delete",
    scope: "/data/granted/row.csv",
    effects: ["deletes"],
    grants: [
      {
        capability: "files.delete",
        scope: "/data/granted",
        decision: "always",
      },
    ],
  },
  defaultPolicy,
  new Date("2026-11-11T00:00:02.000Z"),
);

const records = [outside.audit, deletes.audit, policy.audit];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript((payload) => {
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke(command: string) {
            if (command === "audit_log") {
              return Promise.resolve(JSON.stringify(payload));
            }
            return Promise.reject(new Error(`unexpected command ${command}`));
          },
        },
      },
    });
  }, records);
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/activity.html"))
      .href,
  );
  const items = page.locator("#activity li");
  await items.nth(2).waitFor();
  const text = await items.allTextContents();
  if (text.length !== 3) {
    throw new Error(`activity length ${text.length}`);
  }
  if (!text[0]?.includes("policy")) {
    throw new Error(`newest was ${text[0]}`);
  }
  if (!text[1]?.includes("needs-approval") || !text[1]?.includes("deletes")) {
    throw new Error(`middle was ${text[1]}`);
  }
  if (!text[2]?.includes("outside grant")) {
    throw new Error(`oldest was ${text[2]}`);
  }
} finally {
  await browser.close();
}
