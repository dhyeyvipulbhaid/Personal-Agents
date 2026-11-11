import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sampleMessages, toEml } from "../mail/sample.ts";

/** North 100, South 80, West 40. The revenue tile totals this to 220. */
export const SAMPLE_REVENUE_CSV =
  "vertical,amount\nNorth,100\nSouth,80\nWest,40\n";

export type DemoPaths = {
  root: string;
  revenueFile: string;
  revenueState: string;
  mailDir: string;
  mailDb: string;
};

export function demoPaths(root: string): DemoPaths {
  return {
    root,
    revenueFile: join(root, "revenue.csv"),
    revenueState: join(root, "revenue-state.json"),
    mailDir: join(root, "mail"),
    mailDb: join(root, "mail-state.sqlite"),
  };
}

/** Copies the demo revenue file and mailbox once. Later edits are kept. */
export function seedDemoData(root: string): DemoPaths {
  const paths = demoPaths(root);
  mkdirSync(paths.mailDir, { recursive: true });
  if (!existsSync(paths.revenueFile)) {
    writeFileSync(paths.revenueFile, SAMPLE_REVENUE_CSV);
  }
  const existing = readdirSync(paths.mailDir).filter((name) =>
    name.endsWith(".eml"),
  );
  if (existing.length === 0) {
    for (const message of sampleMessages()) {
      const name = `${message.id.replace(/[<>@]/g, "")}.eml`;
      writeFileSync(join(paths.mailDir, name), toEml(message));
    }
  }
  return paths;
}
