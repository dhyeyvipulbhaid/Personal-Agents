import { expect, test } from "bun:test";
import { MemoryStore } from "./memory.ts";

test("a fact from session A is recalled in session B with its source", () => {
  const memory = new MemoryStore();
  memory.remember("session-a", "the revenue total is 220");

  const recalled = memory.recall("revenue total");

  expect(recalled).toHaveLength(1);
  expect(recalled[0]?.text).toBe("the revenue total is 220");
  expect(recalled[0]?.source).toBe("session-a");
});

test("a deleted fact is no longer recalled", () => {
  const memory = new MemoryStore();
  const fact = memory.remember("session-a", "the revenue total is 220");
  memory.delete(fact.id);

  expect(memory.recall("revenue total")).toEqual([]);
  expect(memory.view()).toEqual([]);
});

test("two tasks do not share working memory", () => {
  const memory = new MemoryStore();
  memory.setWorking("task-1", "note", "alpha");
  memory.setWorking("task-2", "note", "beta");

  expect(memory.getWorking("task-1", "note")).toBe("alpha");
  expect(memory.getWorking("task-2", "note")).toBe("beta");
  expect(memory.getWorking("task-1", "other")).toBeUndefined();
});

test("an edited fact is what recall returns", () => {
  const memory = new MemoryStore();
  const fact = memory.remember("session-a", "the revenue total is 220");
  memory.edit(fact.id, "the revenue total is 180");

  expect(memory.recall("revenue")[0]?.text).toBe("the revenue total is 180");
});
