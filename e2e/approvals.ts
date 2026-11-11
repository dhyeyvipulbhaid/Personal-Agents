import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { Approvals } from "../packages/host/src/approvals/approvals.ts";

const approvals = new Approvals(() => {});
const task = approvals.runTask("alpha", async (ctx) => {
  const result = await ctx.request({
    summary: "delete the row",
    draft: "delete row 1",
    capability: "files.delete",
    effects: ["deletes"],
  });
  return result;
});

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.exposeFunction(
    "hostInvoke",
    async (command: string, args?: Record<string, string | number>) => {
      if (command === "approvals") {
        return JSON.stringify(approvals.pending());
      }
      if (command === "approval_act") {
        const id = String(args?.id ?? "");
        const action = String(args?.action ?? "");
        if (action === "edit") {
          approvals.edit(id, String(args?.draft ?? ""));
        } else if (action === "approve") {
          approvals.approve(id, args?.scope === "task" ? "task" : "once");
        } else if (action === "deny") {
          approvals.deny(id);
        } else if (action === "more-info") {
          approvals.moreInfo(id, String(args?.instruction ?? ""));
        } else if (action === "snooze") {
          approvals.snooze(id, Number(args?.until ?? 0));
        } else {
          throw new Error(`unexpected action ${action}`);
        }
        return JSON.stringify(approvals.pending());
      }
      throw new Error(`unexpected command ${command}`);
    },
  );
  await page.addInitScript(() => {
    const host = window as unknown as {
      hostInvoke: (command: string, args?: unknown) => Promise<string>;
    };
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke: (command: string, args?: unknown) =>
            host.hostInvoke(command, args),
        },
      },
    });
  });
  await page.goto(
    pathToFileURL(join(import.meta.dir, "../apps/desktop/ui/approvals.html"))
      .href,
  );
  await page.getByRole("heading", { name: "delete the row" }).waitFor();
  await page.getByRole("button", { name: "Deny" }).waitFor();
  await page.locator("textarea").fill("delete row 2");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("No waiting requests").waitFor();
} finally {
  await browser.close();
}

const result = await task;
if (result.decision !== "approved" || result.draft !== "delete row 2") {
  throw new Error(`approval result ${JSON.stringify(result)}`);
}
