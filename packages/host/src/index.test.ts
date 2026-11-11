import { expect, test } from "bun:test";
import { readSqliteProbe } from "./index.ts";

test("sqlite probe returns the selected value", () => {
  expect(readSqliteProbe()).toBe(0);
});
