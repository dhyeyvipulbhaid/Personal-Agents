import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromeExecutable } from "../browser/drive.ts";
import { type Check, probeCapabilities } from "./probe.ts";

type Folder = { path: string; readable: boolean };
type Browser = { name: string; installed: boolean };
type Policy = { key: string; value: string };

const BROWSER_PATHS: { name: string; paths: string[] }[] = [
  {
    name: "Chrome",
    paths: [
      "/Applications/Google Chrome.app",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    name: "Edge",
    paths: [
      "/Applications/Microsoft Edge.app",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    ],
  },
  {
    name: "Safari",
    paths: ["/Applications/Safari.app"],
  },
  {
    name: "Firefox",
    paths: [
      "/Applications/Firefox.app",
      "/usr/bin/firefox",
      "/usr/bin/firefox-esr",
    ],
  },
];

/** Browsers this machine can actually open. Missing ones stay in the report. */
export function installedBrowsers(): Browser[] {
  return BROWSER_PATHS.map((browser) => ({
    name: browser.name,
    installed:
      browser.paths.some((path) => existsSync(path)) ||
      (browser.name === "Chrome" && chromeExecutable() !== null),
  }));
}

export function folderReadable(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return existsSync(path);
  }
}

/**
 * Reads RemoteDebuggingAllowed when the OS exposes it.
 * PA_REMOTE_DEBUGGING=true|false overrides the lookup in tests.
 */
export function readRemoteDebuggingPolicy(): Policy[] {
  const fromEnv = process.env.PA_REMOTE_DEBUGGING;
  if (fromEnv === "true" || fromEnv === "false") {
    return [{ key: "RemoteDebuggingAllowed", value: fromEnv }];
  }
  if (process.platform === "darwin") {
    return policyFromText(
      commandOutput("defaults", [
        "read",
        "com.google.Chrome",
        "RemoteDebuggingAllowed",
      ]),
    );
  }
  if (process.platform === "win32") {
    return policyFromText(
      commandOutput("reg", [
        "query",
        "HKCU\\SOFTWARE\\Policies\\Google\\Chrome",
        "/v",
        "RemoteDebuggingAllowed",
      ]),
    );
  }
  for (const file of [
    "/etc/opt/chrome/policies/managed/managed.json",
    "/etc/chromium/policies/managed/managed.json",
  ]) {
    if (!existsSync(file)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        RemoteDebuggingAllowed?: boolean;
      };
      if (typeof parsed.RemoteDebuggingAllowed === "boolean") {
        return [
          {
            key: "RemoteDebuggingAllowed",
            value: parsed.RemoteDebuggingAllowed ? "true" : "false",
          },
        ];
      }
    } catch {
      // A policy file that is not JSON is ignored. The check stays open.
    }
  }
  return [];
}

export function machineChecks(input: {
  folders: Folder[];
  ollamaPortOpen: boolean;
  models: string[];
  browsers?: Browser[];
  policies?: Policy[];
}): Check[] {
  return probeCapabilities({
    folders: input.folders,
    browsers: input.browsers ?? installedBrowsers(),
    policies: input.policies ?? readRemoteDebuggingPolicy(),
    ollamaPortOpen: input.ollamaPortOpen,
    models: input.models,
  });
}

export function adviceFor(check: Check): string {
  if (check.status === "available") {
    return "";
  }
  if (check.name === "ollama" && check.cause === "port closed") {
    return "Install Ollama from https://ollama.com/download and start it. Then run `ollama pull qwen3:4b`.";
  }
  if (check.name === "ollama" && check.cause === "no models") {
    return "Run `ollama pull qwen3:4b`, `ollama pull qwen3:8b`, and `ollama pull qwen2.5-coder:7b`.";
  }
  if (check.cause === "not installed") {
    return "Install that browser, or use one that is already on this machine.";
  }
  if (check.cause === "not readable") {
    return "Grant this account access to that folder, then reopen Capabilities.";
  }
  if (check.cause === "RemoteDebuggingAllowed") {
    return "Remote debugging is turned off by policy, so the browser agent cannot attach.";
  }
  if (check.name.startsWith("model ")) {
    return "";
  }
  return "This check failed. The cause is listed on the card.";
}

function commandOutput(command: string, args: string[]): string {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
    });
    if (result.status !== 0) {
      return "";
    }
    return result.stdout ?? "";
  } catch {
    return "";
  }
}

function policyFromText(output: string): Policy[] {
  const text = output.trim();
  if (text.length === 0) {
    return [];
  }
  if (/\b0x0\b|\bfalse\b/.test(text) || text === "0") {
    return [{ key: "RemoteDebuggingAllowed", value: "false" }];
  }
  if (/\b0x1\b|\btrue\b/.test(text) || text === "1") {
    return [{ key: "RemoteDebuggingAllowed", value: "true" }];
  }
  return [];
}

export function readableFolders(paths: string[]): Folder[] {
  return paths.map((path) => ({
    path: join(path),
    readable: folderReadable(path),
  }));
}
