import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catchUpRefresh,
  revenueAlerts,
  revenueTotal,
  statusLine,
  tileStatus,
} from "./revenue.ts";
import { readRevenueTable, rowsFromSheetXml } from "./table.ts";
import { writeStoredZip } from "./zip.ts";

const sample = [
  { vertical: "North", amount: 100 },
  { vertical: "South", amount: 80 },
  { vertical: "West", amount: 40 },
];

test("csv, excel, and sqlite revenue rows match the reference total", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-revenue-"));
  const csv = join(dir, "revenue.csv");
  writeFileSync(csv, "vertical,amount\nNorth,100\nSouth,80\nWest,40\n");
  const xlsx = join(dir, "revenue.xlsx");
  writeFileSync(xlsx, workbook(sample));
  const sqlite = join(dir, "revenue.sqlite");
  const db = new Database(sqlite);
  db.run("CREATE TABLE revenue (vertical TEXT, amount REAL)");
  const insert = db.prepare(
    "INSERT INTO revenue (vertical, amount) VALUES (?, ?)",
  );
  for (const row of sample) {
    insert.run(row.vertical, row.amount);
  }
  db.close();

  const fromCsv = readRevenueTable(csv, dir);
  const fromXlsx = readRevenueTable(xlsx, dir);
  const fromSqlite = readRevenueTable(sqlite, dir);

  expect(fromCsv.rows).toEqual(sample);
  expect(fromXlsx.rows).toEqual(sample);
  expect(fromSqlite.rows).toEqual(sample);
  expect(revenueTotal(fromCsv.rows)).toBe(220);
  expect(revenueTotal(fromXlsx.rows)).toBe(revenueTotal(sample));
  expect(revenueTotal(fromSqlite.rows)).toBe(revenueTotal(sample));
  expect(rowsFromSheetXml(sheetXml(sample)).map((row) => row.vertical)).toEqual(
    ["North", "South", "West"],
  );
});

test("reading outside the granted folder is denied and logged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-grant-"));
  const outside = mkdtempSync(join(tmpdir(), "pa-outside-"));
  const file = join(outside, "revenue.csv");
  writeFileSync(file, "vertical,amount\nNorth,100\n");

  const result = readRevenueTable(file, dir);

  expect(result.rows).toEqual([]);
  expect(result.audit.decision).toBe("deny");
  expect(result.audit.reason).toBe("outside grant");
  expect(result.audit.summary).toContain("outside grant");
});

test("a 10 percent drop fires one alert and a 9 percent drop fires none", () => {
  const north = { vertical: "North", amount: 100 };
  const south = { vertical: "South", amount: 80 };
  const west = { vertical: "West", amount: 40 };
  const previous = [north, south, west];
  expect(
    revenueAlerts(previous, [{ ...north, amount: 90 }, south, west]),
  ).toEqual(["North"]);
  expect(
    revenueAlerts(previous, [{ ...north, amount: 91 }, south, west]),
  ).toEqual([]);
});

test("two missed refreshes become one catch-up and a missed note", () => {
  const everyMs = 1_000;
  const last = 0;
  const acrossTwo = catchUpRefresh(last, 2_500, everyMs);
  expect(acrossTwo).toEqual({ refresh: true, missed: true });
  const line = statusLine(
    tileStatus({
      health: "ok",
      lastRefreshMs: 2_500,
      everyMs,
      missed: true,
      waitingApprovals: 0,
    }),
  );
  expect(line).toContain("health ok");
  expect(line).toContain("missed a refresh");
  expect(line).toContain("waiting approvals 0");
  expect(line).toContain("next ");
});

function workbook(rows: { vertical: string; amount: number }[]): Uint8Array {
  const xml = sheetXml(rows);
  return writeStoredZip([
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(xml) },
  ]);
}

function sheetXml(rows: { vertical: string; amount: number }[]): string {
  const body = rows
    .map(
      (row) =>
        `<row><c t="inlineStr"><is><t>${row.vertical}</t></is></c><c><v>${row.amount}</v></c></row>`,
    )
    .join("");
  return `<worksheet><sheetData><row><c t="inlineStr"><is><t>vertical</t></is></c><c t="inlineStr"><is><t>amount</t></is></c></row>${body}</sheetData></worksheet>`;
}
