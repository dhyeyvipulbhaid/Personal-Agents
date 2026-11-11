import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type AuditRecord, decide } from "../broker/broker.ts";
import { readZip } from "./zip.ts";

export type RevenueRow = {
  vertical: string;
  amount: number;
};

export type TableRead = {
  rows: RevenueRow[];
  audit: AuditRecord;
};

/** Reads CSV, Excel, or SQLite revenue rows from a granted folder. */
export function readRevenueTable(file: string, grantFolder: string): TableRead {
  const allowed = insideFolder(grantFolder, file);
  const outcome = decide({
    pluginId: "files",
    capability: "files.read",
    scope: slash(file),
    grants: allowed
      ? [
          {
            capability: "files.read",
            scope: slash(grantFolder),
            decision: "always",
          },
        ]
      : [],
  });
  if (outcome.decision !== "allow") {
    return { rows: [], audit: outcome.audit };
  }
  return { rows: readAny(file), audit: outcome.audit };
}

export function rowsFromCsv(text: string): RevenueRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = splitCsv(lines[0] ?? "");
  const verticalIndex = header.indexOf("vertical");
  const amountIndex = header.indexOf("amount");
  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    return {
      vertical: cells[verticalIndex] ?? "",
      amount: Number(cells[amountIndex] ?? "0"),
    };
  });
}

export function rowsFromSheetXml(xml: string): RevenueRow[] {
  const parsed: string[][] = [];
  for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const cell of row.match(/<c\b[\s\S]*?<\/c>/g) ?? []) {
      const inline = cell.match(/<t>([^<]*)<\/t>/);
      const value = cell.match(/<v>([^<]*)<\/v>/);
      cells.push(inline?.[1] ?? value?.[1] ?? "");
    }
    parsed.push(cells);
  }
  const header = parsed[0] ?? [];
  const verticalIndex = header.indexOf("vertical");
  const amountIndex = header.indexOf("amount");
  return parsed.slice(1).map((cells) => ({
    vertical: cells[verticalIndex] ?? "",
    amount: Number(cells[amountIndex] ?? "0"),
  }));
}

export function rowsFromSqlite(file: string): RevenueRow[] {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .query("SELECT vertical, amount FROM revenue")
      .all() as RevenueRow[];
  } finally {
    db.close();
  }
}

function readAny(file: string): RevenueRow[] {
  const lower = file.toLowerCase();
  if (lower.endsWith(".csv")) {
    return rowsFromCsv(readFileSync(file, "utf8"));
  }
  if (lower.endsWith(".xlsx")) {
    const entries = readZip(new Uint8Array(readFileSync(file)));
    const sheet = entries.find((entry) => entry.name.endsWith("sheet1.xml"));
    if (!sheet) {
      throw new Error("workbook has no sheet");
    }
    return rowsFromSheetXml(new TextDecoder().decode(sheet.data));
  }
  return rowsFromSqlite(file);
}

function splitCsv(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

function insideFolder(folder: string, file: string): boolean {
  const root = resolve(folder);
  const target = resolve(file);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function slash(file: string): string {
  return resolve(file).replaceAll("\\", "/");
}
