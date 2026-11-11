export type Check = {
  name: string;
  status: "available" | "blocked";
  cause: string;
};

export type ProbeInput = {
  folders: { path: string; readable: boolean }[];
  browsers: { name: string; installed: boolean }[];
  policies: { key: string; value: string }[];
  ollamaPortOpen: boolean;
  models: string[];
};

/** The same checks the panel and the doctor command print. */
export function probeCapabilities(input: ProbeInput): Check[] {
  const checks: Check[] = [];
  for (const folder of input.folders) {
    checks.push({
      name: `folder ${folder.path}`,
      status: folder.readable ? "available" : "blocked",
      cause: folder.readable ? "" : "not readable",
    });
  }
  for (const browser of input.browsers) {
    checks.push({
      name: `browser ${browser.name}`,
      status: browser.installed ? "available" : "blocked",
      cause: browser.installed ? "" : "not installed",
    });
  }
  const remote = input.policies.find(
    (policy) => policy.key === "RemoteDebuggingAllowed",
  );
  const remoteBlocked = remote?.value === "false";
  checks.push({
    name: "remote debugging",
    status: remoteBlocked ? "blocked" : "available",
    cause: remoteBlocked ? "RemoteDebuggingAllowed" : "",
  });
  const ollamaReady = input.ollamaPortOpen && input.models.length > 0;
  checks.push({
    name: "ollama",
    status: ollamaReady ? "available" : "blocked",
    cause: input.ollamaPortOpen ? "no models" : "port closed",
  });
  for (const model of input.models) {
    checks.push({ name: `model ${model}`, status: "available", cause: "" });
  }
  return checks;
}

export function doctorText(checks: Check[]): string {
  return checks
    .map((check) => {
      const cause = check.cause.length > 0 ? `\t${check.cause}` : "";
      return `${check.status}\t${check.name}${cause}`;
    })
    .join("\n");
}
