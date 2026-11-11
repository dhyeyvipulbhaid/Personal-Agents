import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Approvals } from "../approvals/approvals.ts";
import { ModelSettings } from "../models/adapter.ts";
import { PluginKernel } from "../plugins/kernel.ts";
import {
  previewWidget,
  specFromRequest,
  templateSpec,
  WidgetBuilder,
} from "./builder.ts";

const rows = [
  { vertical: "North", amount: 100 },
  { vertical: "South", amount: 80 },
];

test("a one-line request installs a no-code number widget", async () => {
  const spec = specFromRequest("show total revenue as a big number");
  expect(spec).toEqual({ source: "revenue", display: "number" });
  expect("code" in spec).toBe(false);
  const preview = previewWidget(spec, rows);
  expect(preview).toContain("180");
  expect(preview).toContain("__PA_THEME__");
  expect(preview.includes("fetch(")).toBe(false);

  const { builder, kernel, approvals } = harness();
  const approvalId = builder.requestInstall(spec, rows, "total-widget");
  expect(approvals.pending()[0]?.summary).toContain("llama");
  await builder.approveInstall(approvalId);

  expect(kernel.tiles()[0]?.html).toContain("180");
  builder.remove("total-widget");
  expect(kernel.registrations()).toEqual([]);
});

test("each starter template installs a working widget", async () => {
  const { builder, kernel } = harness();
  for (const name of ["kpi", "table", "alert"] as const) {
    const spec = templateSpec(name);
    const approvalId = builder.requestInstall(spec, rows, name);
    await builder.approveInstall(approvalId);
    expect(kernel.tiles().some((tile) => tile.id === name)).toBe(true);
    builder.remove(name);
  }
  expect(kernel.registrations()).toEqual([]);
});

test("the builder source does not call the network", () => {
  const source = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");
  expect(source.includes("fetch(")).toBe(false);
});

function harness(): {
  builder: WidgetBuilder;
  kernel: PluginKernel;
  approvals: Approvals;
} {
  const kernel = new PluginKernel();
  const approvals = new Approvals(() => {});
  const settings = new ModelSettings();
  settings.set("builder", "llama", [
    {
      name: "llama",
      tools: true,
      streaming: true,
      structured: true,
    },
  ]);
  return {
    kernel,
    approvals,
    builder: new WidgetBuilder(kernel, approvals, settings),
  };
}
