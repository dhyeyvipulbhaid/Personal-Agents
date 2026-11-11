import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  catchUpRefresh,
  revenueAlerts,
  revenueTotal,
  statusLine,
  tileStatus,
} from "./revenue.ts";
import { type RevenueRow, rowsFromCsv } from "./table.ts";

/** How often the revenue tile expects a refresh. */
export const REVENUE_EVERY_MS = 15 * 60 * 1000;

export type RevenueView = {
  total: number;
  rows: RevenueRow[];
  alerts: string[];
  health: "ok" | "alert";
  lastRefresh: string;
  nextRefresh: string;
  missed: boolean;
  waitingApprovals: number;
  line: string;
  file: string;
};

type SavedRevenue = {
  lastRefreshMs: number;
  rows: RevenueRow[];
};

/** Reads the sample table, compares it with the last snapshot, and records this refresh. */
export function loadRevenueView(
  file: string,
  stateFile: string,
  now: number,
  waitingApprovals: number,
): RevenueView {
  const rows = rowsFromCsv(readFileSync(file, "utf8"));
  let previous = rows;
  let last = now;
  let missed = false;
  if (existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as SavedRevenue;
    if (Array.isArray(saved.rows) && typeof saved.lastRefreshMs === "number") {
      previous = saved.rows;
      const catchup = catchUpRefresh(
        saved.lastRefreshMs,
        now,
        REVENUE_EVERY_MS,
      );
      missed = catchup.missed;
      last = catchup.refresh ? now : saved.lastRefreshMs;
    }
  }
  const alerts = revenueAlerts(previous, rows);
  const health = alerts.length > 0 ? "alert" : "ok";
  const status = tileStatus({
    health,
    lastRefreshMs: last,
    everyMs: REVENUE_EVERY_MS,
    missed,
    waitingApprovals,
  });
  mkdirSync(dirname(stateFile), { recursive: true });
  const next: SavedRevenue = { lastRefreshMs: last, rows };
  writeFileSync(stateFile, JSON.stringify(next));
  return {
    total: revenueTotal(rows),
    rows,
    alerts,
    health,
    lastRefresh: status.lastRefresh,
    nextRefresh: status.nextRefresh,
    missed: status.missed,
    waitingApprovals,
    line: statusLine(status),
    file,
  };
}
