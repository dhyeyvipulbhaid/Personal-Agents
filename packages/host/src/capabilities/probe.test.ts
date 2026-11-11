import { expect, test } from "bun:test";
import { doctorText, probeCapabilities } from "./probe.ts";

test("remote debugging blocked by policy is named on the panel and in doctor", () => {
  const checks = probeCapabilities({
    folders: [{ path: "/data", readable: true }],
    browsers: [{ name: "Chrome", installed: true }],
    policies: [{ key: "RemoteDebuggingAllowed", value: "false" }],
    ollamaPortOpen: true,
    models: ["llama"],
  });
  const remote = checks.find((check) => check.name === "remote debugging");
  expect(remote?.status).toBe("blocked");
  expect(remote?.cause).toBe("RemoteDebuggingAllowed");
  expect(doctorText(checks)).toContain(
    "blocked\tremote debugging\tRemoteDebuggingAllowed",
  );
});

test("an open machine shows folders, the browser, ollama, and models as available", () => {
  const checks = probeCapabilities({
    folders: [{ path: "/data", readable: true }],
    browsers: [{ name: "Chrome", installed: true }],
    policies: [{ key: "RemoteDebuggingAllowed", value: "true" }],
    ollamaPortOpen: true,
    models: ["llama"],
  });
  expect(checks.every((check) => check.status === "available")).toBe(true);
});

test("the ollama row names the models it found", () => {
  const models = ["qwen3:4b", "qwen3:8b", "qwen2.5-coder:7b"];
  const checks = probeCapabilities({
    folders: [],
    browsers: [],
    policies: [],
    ollamaPortOpen: true,
    models,
  });
  const ollama = checks.find((check) => check.name === "ollama");
  expect(ollama?.status).toBe("available");
  expect(ollama?.cause).toBe(models.join(", "));
});
