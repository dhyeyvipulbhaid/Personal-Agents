import type { RevenueRow } from "./table.ts";

export type TileStatus = {
  health: "ok" | "alert";
  lastRefresh: string;
  nextRefresh: string;
  missed: boolean;
  waitingApprovals: number;
};

/** Sum of the amount column. This is the reference total. */
export function revenueTotal(rows: RevenueRow[]): number {
  return rows.reduce((sum, row) => sum + row.amount, 0);
}

/** One alert per vertical that fell by 10 percent or more. */
export function revenueAlerts(
  previous: RevenueRow[],
  next: RevenueRow[],
): string[] {
  const alerts: string[] = [];
  for (const row of next) {
    const before = previous.find((item) => item.vertical === row.vertical);
    if (!before || before.amount <= 0) {
      continue;
    }
    const drop = (before.amount - row.amount) / before.amount;
    if (drop >= 0.1) {
      alerts.push(row.vertical);
    }
  }
  return alerts;
}

/**
 * If two or more refreshes were missed while the app was closed, run one
 * catch-up refresh and mark the tile missed.
 */
export function catchUpRefresh(
  lastRefreshMs: number,
  nowMs: number,
  everyMs: number,
): { refresh: boolean; missed: boolean } {
  const missedCount = Math.floor((nowMs - lastRefreshMs) / everyMs);
  if (missedCount >= 2) {
    return { refresh: true, missed: true };
  }
  if (missedCount >= 1) {
    return { refresh: true, missed: false };
  }
  return { refresh: false, missed: false };
}

export function tileStatus(input: {
  health: "ok" | "alert";
  lastRefreshMs: number;
  everyMs: number;
  missed: boolean;
  waitingApprovals: number;
}): TileStatus {
  return {
    health: input.health,
    lastRefresh: new Date(input.lastRefreshMs).toISOString(),
    nextRefresh: new Date(input.lastRefreshMs + input.everyMs).toISOString(),
    missed: input.missed,
    waitingApprovals: input.waitingApprovals,
  };
}

export function statusLine(status: TileStatus): string {
  const missed = status.missed ? ", missed a refresh" : "";
  return `health ${status.health}, last ${status.lastRefresh}, next ${status.nextRefresh}${missed}, waiting approvals ${status.waitingApprovals}`;
}
