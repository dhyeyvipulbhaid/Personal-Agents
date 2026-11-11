import { writeSync } from "node:fs";
import { Approvals } from "./approvals/approvals.ts";
import { decide } from "./broker/broker.ts";
import { probeOllama } from "./ollama.ts";
import { HELLO_PLUGIN_SOURCE } from "./plugins/hello.ts";
import { kernel } from "./plugins/runtime.ts";
import { encodeNotification, serveStdio } from "./rpc.ts";

try {
  await kernel.load(HELLO_PLUGIN_SOURCE);
} catch (error) {
  const message =
    error instanceof Error ? error.message : "hello plugin failed";
  console.error(message);
  process.exit(1);
}

let ollamaStatus: "running" | "stopped" = "stopped";
try {
  ollamaStatus = await probeOllama();
} catch {
  ollamaStatus = "stopped";
}

const approvals = new Approvals((entry) => {
  writeSync(1, encodeNotification("audit", entry));
});

await serveStdio({
  widgets: () => JSON.stringify(kernel.tiles()),
  ollama: () => ollamaStatus,
  authorize: (params) => {
    const outcome = decide(params);
    writeSync(1, encodeNotification("audit", outcome.audit));
    return JSON.stringify({
      decision: outcome.decision,
      reason: outcome.reason,
    });
  },
  approvals: () => JSON.stringify(approvals.pending()),
  approval_act: (params) => JSON.stringify(act(approvals, params)),
});

function act(
  queue: Approvals,
  params: unknown,
): ReturnType<Approvals["pending"]> {
  const record = isRecord(params) ? params : {};
  const id = typeof record.id === "string" ? record.id : "";
  const action = typeof record.action === "string" ? record.action : "";
  if (action === "approve") {
    queue.approve(id, record.scope === "task" ? "task" : "once");
  } else if (action === "deny") {
    queue.deny(id);
  } else if (action === "more-info") {
    queue.moreInfo(
      id,
      typeof record.instruction === "string" ? record.instruction : "",
    );
  } else if (action === "edit") {
    queue.edit(id, typeof record.draft === "string" ? record.draft : "");
  } else if (action === "snooze") {
    const until =
      typeof record.until === "number" ? record.until : Date.now() + 60_000;
    queue.snooze(id, until);
  } else {
    throw new Error("unknown approval action");
  }
  return queue.pending();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
