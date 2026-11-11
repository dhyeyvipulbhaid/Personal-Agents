import { Database } from "bun:sqlite";

/** Opens an in-memory database and returns the result of `SELECT 1`. */
export function readSqliteProbe(): number {
  const db = new Database(":memory:");
  try {
    const row = db.query("SELECT 1 AS ok").get() as { ok: number } | null;
    if (row === null) {
      throw new Error("sqlite probe returned no row");
    }
    return row.ok;
  } finally {
    db.close();
  }
}
