import type { Approvals } from "../approvals/approvals.ts";
import { revenueTotal } from "../files/revenue.ts";
import type { RevenueRow } from "../files/table.ts";
import type { ModelSettings } from "../models/adapter.ts";
import type { PluginKernel } from "../plugins/kernel.ts";

export type WidgetSpec = {
  source: "revenue";
  display: "number" | "table" | "alert";
  threshold?: number;
};

const TEMPLATES: Record<"kpi" | "table" | "alert", WidgetSpec> = {
  kpi: { source: "revenue", display: "number" },
  table: { source: "revenue", display: "table" },
  alert: { source: "revenue", display: "alert", threshold: 0.1 },
};

/** A one-line request becomes a spec. The builder does not emit widget code. */
export function specFromRequest(text: string): WidgetSpec {
  const normalized = text.trim().toLowerCase();
  if (normalized.includes("total revenue") && normalized.includes("number")) {
    return { source: "revenue", display: "number" };
  }
  if (normalized.includes("table")) {
    return { source: "revenue", display: "table" };
  }
  if (normalized.includes("threshold") || normalized.includes("alert")) {
    return { source: "revenue", display: "alert", threshold: 0.1 };
  }
  throw new Error("the builder could not make a spec");
}

export function templateSpec(name: "kpi" | "table" | "alert"): WidgetSpec {
  return { ...TEMPLATES[name] };
}

/** The name a person sees. The spec still stores number, table, or alert. */
export function widgetTitle(spec: WidgetSpec): string {
  if (spec.display === "table") {
    return "Revenue table";
  }
  if (spec.display === "alert") {
    return "Revenue alert";
  }
  return "Total revenue";
}

export function staticCheck(spec: WidgetSpec): void {
  if (spec.source !== "revenue") {
    throw new Error("unsupported data source");
  }
  if (spec.display === "alert" && typeof spec.threshold !== "number") {
    throw new Error("alert needs a threshold");
  }
}

export function previewWidget(spec: WidgetSpec, rows: RevenueRow[]): string {
  staticCheck(spec);
  const total = revenueTotal(rows);
  if (spec.display === "number") {
    return `<p data-theme="__PA_THEME__">${total}</p>`;
  }
  if (spec.display === "table") {
    const body = rows
      .map((row) => `<tr><td>${row.vertical}</td><td>${row.amount}</td></tr>`)
      .join("");
    return `<table data-theme="__PA_THEME__">${body}</table>`;
  }
  return `<p data-theme="__PA_THEME__">threshold ${spec.threshold}</p>`;
}

export class WidgetBuilder {
  private readonly tasks = new Map<string, Promise<void>>();

  constructor(
    private readonly kernel: PluginKernel,
    private readonly approvals: Approvals,
    private readonly settings: ModelSettings,
  ) {}

  requestInstall(spec: WidgetSpec, rows: RevenueRow[], id: string): string {
    staticCheck(spec);
    const html = previewWidget(spec, rows);
    if (this.settings.get("builder").trim().length === 0) {
      throw new Error("Choose a builder model before installing a widget.");
    }
    const task = this.approvals.runTask("builder", async (ctx) => {
      const result = await ctx.request({
        summary: `install '${widgetTitle(spec)}' widget`,
        draft: html,
        capability: "widget.install",
      });
      if (result.decision !== "approved") {
        return;
      }
      await this.kernel.load(pluginSource(id, widgetTitle(spec), result.draft));
    });
    const pending = this.approvals.pending().at(-1);
    if (!pending) {
      throw new Error("install did not request approval");
    }
    this.tasks.set(pending.id, task);
    return pending.id;
  }

  async approveInstall(approvalId: string): Promise<void> {
    this.approvals.approve(approvalId);
    const task = this.tasks.get(approvalId);
    if (task) {
      await task;
    }
  }

  remove(id: string): void {
    this.kernel.unload(id);
  }
}

function pluginSource(id: string, title: string, html: string): string {
  return `
export const manifest = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(title)},
  version: "0.0.0",
  minCoreVersion: "0.0.0",
  tile: { title: ${JSON.stringify(title)} },
  effects: ["tile"]
};
export function apply(ctx) {
  ctx.register({
    effect: "tile",
    id: ${JSON.stringify(id)},
    title: ${JSON.stringify(title)},
    html: ${JSON.stringify(html)}
  });
}
`;
}
