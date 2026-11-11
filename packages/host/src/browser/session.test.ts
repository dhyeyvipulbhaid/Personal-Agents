import { expect, test } from "bun:test";
import { Approvals } from "../approvals/approvals.ts";
import { probeCapabilities } from "../capabilities/probe.ts";
import { BrowserSession, chooseRung } from "./session.ts";

const scripted = ["open the form", "fill the name", "submit"];

test("a scripted task shows each step and stop ends the session", async () => {
  const approvals = new Approvals(() => {});
  const session = new BrowserSession(approvals);
  const visit = session.visit("https://example.test/form");
  const id = approvals.pending()[0]?.id ?? "";
  expect(id.length).toBeGreaterThan(0);
  approvals.approve(id);
  await visit;
  session.runScript(scripted);
  expect(session.liveView()).toEqual([
    "open https://example.test/form",
    ...scripted,
  ]);

  const elapsed = session.stop();
  expect(elapsed).toBeLessThan(2_000);
  session.runScript(["should not run"]);
  expect(session.liveView()).not.toContain("should not run");
});

test("the first visit to a site waits and the next visit to that site does not", async () => {
  const approvals = new Approvals(() => {});
  const session = new BrowserSession(approvals);
  const first = session.visit("https://example.test/a");
  approvals.approve(approvals.pending()[0]?.id ?? "");
  await first;
  const before = approvals.pending().length;
  await session.visit("https://example.test/b");
  expect(approvals.pending().length).toBe(before);
});

test("a denied visit does not open the page", async () => {
  const approvals = new Approvals(() => {});
  const session = new BrowserSession(approvals);
  const visit = session.visit("https://example.test/secret");
  approvals.deny(approvals.pending()[0]?.id ?? "");
  await visit;
  expect(session.liveView()).toEqual([]);
});

test("blocked remote debugging drops to rung 5 and explains why", () => {
  const checks = probeCapabilities({
    folders: [],
    browsers: [],
    policies: [{ key: "RemoteDebuggingAllowed", value: "false" }],
    ollamaPortOpen: true,
    models: ["llama"],
  });
  const choice = chooseRung(checks);
  expect(choice.rung).toBe(5);
  expect(choice.explanation).toContain("RemoteDebuggingAllowed");
  expect(choice.explanation).toContain("rungs 0 and 1");
});
