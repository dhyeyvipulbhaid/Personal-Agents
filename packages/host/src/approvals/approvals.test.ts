import { expect, test } from "bun:test";
import { type ActivityEntry, Approvals, PluginConfigs } from "./approvals.ts";

function harness(now = 1_700_000_000_000) {
  const entries: ActivityEntry[] = [];
  let clock = now;
  const approvals = new Approvals(
    (entry) => entries.push(entry),
    () => clock,
  );
  return {
    approvals,
    entries,
    setNow(value: number) {
      clock = value;
    },
  };
}

test("an unchanged draft is not logged and markup is not stored in the summary", async () => {
  const { approvals, entries } = harness();
  const task = approvals.runTask("builder", async (ctx) => {
    return ctx.request({
      summary: "install 'Total revenue' widget",
      draft: "<p>220</p>",
      capability: "widget.install",
    });
  });
  const id = approvals.pending()[0]?.id ?? "";
  approvals.edit(id, "<p>220</p>");
  expect(entries.some((entry) => entry.decision === "edited")).toBe(false);
  approvals.edit(id, "<p>221</p>");
  expect(entries.at(-1)?.summary).toBe("Edited: 221");
  approvals.approve(id);
  expect(entries.at(-1)?.summary).toBe(
    "Approved: install 'Total revenue' widget",
  );
  expect(await task).toMatchObject({ decision: "approved" });
});

test("a task pauses on a request while a second task keeps running", async () => {
  const { approvals, entries } = harness();
  const first = approvals.runTask("alpha", async (task) => {
    const result = await task.request({
      summary: "delete the row",
      draft: "delete row 1",
      capability: "files.delete",
      effects: ["deletes"],
    });
    return result.draft;
  });
  let secondFinished = false;
  const second = approvals.runTask("beta", async () => {
    secondFinished = true;
    return "beta-ok";
  });

  expect(await second).toBe("beta-ok");
  expect(secondFinished).toBe(true);
  expect(approvals.pending().map((item) => item.taskId)).toEqual(["alpha"]);

  approvals.approve(approvals.pending()[0]?.id ?? "");
  expect(await first).toBe("delete row 1");
  expect(entries.map((entry) => entry.decision)).toContain("approved");
});

test("a more-info reply is the task's next instruction", async () => {
  const { approvals, entries } = harness();
  const task = approvals.runTask("alpha", async (ctx) => {
    const result = await ctx.request({
      summary: "which file",
      draft: "read a.csv",
      capability: "files.read",
    });
    return result.instruction;
  });

  approvals.moreInfo(approvals.pending()[0]?.id ?? "", "use the other file");

  expect(await task).toBe("use the other file");
  expect(
    entries.some((entry) => entry.summary.includes("use the other file")),
  ).toBe(true);
});

test("an edited draft is what runs", async () => {
  const { approvals, entries } = harness();
  const task = approvals.runTask("alpha", async (ctx) => {
    const result = await ctx.request({
      summary: "draft",
      draft: "delete row 1",
      capability: "files.delete",
    });
    return result.draft;
  });
  const id = approvals.pending()[0]?.id ?? "";

  approvals.edit(id, "delete row 2");
  approvals.approve(id);

  expect(await task).toBe("delete row 2");
  expect(entries.some((entry) => entry.summary.includes("delete row 2"))).toBe(
    true,
  );
});

test("a snoozed request returns at its time", () => {
  const { approvals, entries, setNow } = harness(1_000);
  void approvals.runTask("alpha", async (ctx) => {
    await ctx.request({
      summary: "later",
      draft: "wait",
      capability: "files.read",
    });
  });
  const id = approvals.pending()[0]?.id ?? "";

  approvals.snooze(id, 5_000);
  expect(approvals.pending()).toEqual([]);
  expect(approvals.snoozed()).toHaveLength(1);

  setNow(5_000);
  expect(approvals.pending().map((item) => item.id)).toEqual([id]);
  expect(
    entries.some((entry) => entry.summary.includes("snooze returned")),
  ).toBe(true);
});

test("approve for this task lets the next request in that task continue", async () => {
  const { approvals } = harness();
  const seen: string[] = [];
  const task = approvals.runTask("alpha", async (ctx) => {
    const first = await ctx.request({
      summary: "one",
      draft: "one",
      capability: "files.read",
    });
    seen.push(first.draft);
    const second = await ctx.request({
      summary: "two",
      draft: "two",
      capability: "files.read",
    });
    seen.push(second.draft);
  });
  approvals.approve(approvals.pending()[0]?.id ?? "", "task");
  await task;
  expect(seen).toEqual(["one", "two"]);
});

test("a bad config change is rolled back", async () => {
  const { approvals, entries } = harness();
  const configs = new PluginConfigs(
    approvals,
    async (config) => {
      if (config.bad === "yes") {
        throw new Error("failed to start");
      }
    },
    (entry) => entries.push(entry),
  );
  configs.setCurrent({ bad: "no" });
  const proposal = configs.propose("hello", { bad: "yes" });
  approvals.approve(approvals.pending()[0]?.id ?? "");
  await proposal;

  expect(configs.current()).toEqual({ bad: "no" });
  expect(entries.some((entry) => entry.summary.includes("rolled back"))).toBe(
    true,
  );
});
