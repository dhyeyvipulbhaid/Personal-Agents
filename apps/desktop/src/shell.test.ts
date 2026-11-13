import { expect, test } from "bun:test";
import { SHELL_ID } from "./shell.ts";

test("tauri config is version 2 and uses the shell id", async () => {
  const config = await readConfig();

  expect(config.$schema).toContain("/config/2");
  expect(config.identifier).toBe(SHELL_ID);
});

test("the bundled page shows the app name and version", async () => {
  const config = await readConfig();
  const html = await Bun.file(
    new URL("../ui/index.html", import.meta.url),
  ).text();
  const shell = await Bun.file(
    new URL("../ui/shell.js", import.meta.url),
  ).text();

  expect(config.productName).toBe("Personal Agents");
  expect(html).toContain(config.productName);
  expect(shell).toContain(`Version ${config.version}`);
  expect(config.mainBinaryName).toBe("personal-agents");
  expect(config.build.frontendDist).toBe("../ui");
  expect(config.build.devUrl).toBeUndefined();
});

test("the window can ask for the host version", async () => {
  const html = await Bun.file(
    new URL("../ui/index.html", import.meta.url),
  ).text();
  const shell = await Bun.file(
    new URL("../ui/shell.js", import.meta.url),
  ).text();
  const capabilities = (await Bun.file(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
  ).json()) as { permissions: string[] };
  const config = await readConfig();

  expect(shell).toContain('id="host-version"');
  expect(html).toContain('src="main.js"');
  expect(shell).toContain('invoke("host_version")');
  expect(shell).toContain("Agent host ");
  expect(shell).toContain('invoke("note_displayed_host_version"');
  expect(config.app.withGlobalTauri).toBe(true);
  expect(config.bundle.externalBin).toEqual(["binaries/agent-host"]);
  expect(capabilities.permissions).toContain("allow-host-version");
  expect(capabilities.permissions).toContain(
    "allow-note-displayed-host-version",
  );
  const build = await Bun.file(
    new URL("../src-tauri/build.rs", import.meta.url),
  ).text();
  expect(build).toContain("host_version");
  expect(build).toContain("note_displayed_host_version");
});

test("the main page frames plugin widgets and switches theme", async () => {
  const html = await Bun.file(
    new URL("../ui/index.html", import.meta.url),
  ).text();
  const script = await Bun.file(
    new URL("../ui/main.js", import.meta.url),
  ).text();
  const capabilities = (await Bun.file(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
  ).json()) as { permissions: string[] };
  const config = await readConfig();
  const build = await Bun.file(
    new URL("../src-tauri/build.rs", import.meta.url),
  ).text();

  const shell = await Bun.file(
    new URL("../ui/shell.js", import.meta.url),
  ).text();
  expect(shell).toContain('id="theme"');
  expect(shell).toContain('value="system"');
  expect(shell).toContain('value="light"');
  expect(shell).toContain('value="dark"');
  expect(shell).toContain("Follow system");
  expect(html).toContain('id="widgets"');
  expect(script).toContain('invoke("widgets")');
  expect(script).toContain('setAttribute("sandbox", "")');
  expect(script).toContain("__PA_THEME__");
  expect(config.app.security.csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(capabilities.permissions).toContain("allow-widgets");
  expect(build).toContain("widgets");
  expect(shell).toContain('id="ollama-status"');
  expect(shell).toContain('"activity.html"');
  expect(shell).toContain('"approvals.html"');
  expect(shell).toContain('invoke("ollama_status")');
  expect(shell).toContain("https://ollama.com/download");
  expect(capabilities.permissions).toContain("allow-ollama-status");
  expect(capabilities.permissions).toContain("allow-audit-log");
  expect(capabilities.permissions).toContain("allow-approvals");
  expect(capabilities.permissions).toContain("allow-approval-act");
  expect(build).toContain("audit_log");
  expect(build).toContain("approval_act");
});

test("every page uses one shell and does not say unavailable", async () => {
  const pages = [
    "index.html",
    "chat.html",
    "approvals.html",
    "activity.html",
    "capabilities.html",
    "builder.html",
    "memory.html",
    "mail.html",
  ];
  const shell = await Bun.file(
    new URL("../ui/shell.js", import.meta.url),
  ).text();
  for (const href of [
    "index.html",
    "chat.html",
    "approvals.html",
    "activity.html",
    "capabilities.html",
    "builder.html",
    "memory.html",
    "mail.html",
  ]) {
    expect(shell).toContain(`"${href}"`);
  }
  expect(shell).toContain("Running locally. All data stays on this machine.");
  for (const page of pages) {
    const html = await Bun.file(
      new URL(`../ui/${page}`, import.meta.url),
    ).text();
    expect(html).toContain('src="shell.js"');
    expect(html).not.toContain("<nav>");
    expect(html.toLowerCase()).not.toContain("unavailable");
  }
  const chat = await Bun.file(
    new URL("../ui/chat.html", import.meta.url),
  ).text();
  expect(chat).toContain('id="chat-model"');
  expect(chat).toContain('value="qwen3:8b"');
  expect(chat).not.toContain('value="qwen3:4b"');
  expect(chat).toContain("qwen2.5-coder:7b");
  expect(chat).not.toContain('value="llama"');
  const styles = await Bun.file(
    new URL("../ui/app.css", import.meta.url),
  ).text();
  expect(styles).toContain("fonts/inter-latin-400-normal.woff2");
  expect(styles).not.toContain("http");
});

test("every shell command is registered and permitted", async () => {
  const main = await Bun.file(
    new URL("../src-tauri/src/main.rs", import.meta.url),
  ).text();
  const build = await Bun.file(
    new URL("../src-tauri/build.rs", import.meta.url),
  ).text();
  const capabilities = (await Bun.file(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
  ).json()) as { permissions: string[] };
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(main)?.[1] ?? "";
  const names = [...block.matchAll(/host::([a-z0-9_]+)/g)].map(
    (match) => match[1],
  );
  expect(names).toContain("chat_send");
  expect(names).toContain("revenue_status");
  expect(names).toContain("capabilities");
  expect(names).toContain("list_models");
  for (const name of names) {
    expect(build).toContain(`"${name}"`);
    expect(capabilities.permissions).toContain(
      `allow-${name.replaceAll("_", "-")}`,
    );
  }
});

test("packaging is per-user and unsigned", async () => {
  const config = await readConfig();
  const cargo = await Bun.file(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
  ).text();
  const hooks = await Bun.file(
    new URL("../src-tauri/windows/hooks.nsh", import.meta.url),
  ).text();

  expect(config.bundle.active).toBe(true);
  expect(config.bundle.targets).toEqual(["nsis", "app"]);
  expect(config.bundle.publisher).toBe("Personal Agents");
  expect(config.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(config.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
  expect(config.bundle.windows.webviewInstallMode).toEqual({ type: "skip" });
  expect(config.bundle.macOS.signingIdentity).toBeNull();
  expect(config.bundle.macOS.hardenedRuntime).toBe(false);
  expect(cargo).toContain('default = ["custom-protocol"]');
  expect(hooks).toContain("NSIS_HOOK_POSTUNINSTALL");
});

async function readConfig(): Promise<{
  $schema: string;
  productName: string;
  version: string;
  identifier: string;
  mainBinaryName: string;
  build: { frontendDist: string; devUrl?: string };
  app: { withGlobalTauri: boolean; security: { csp: string } };
  bundle: {
    active: boolean;
    publisher: string;
    targets: string[];
    externalBin: string[];
    windows: {
      webviewInstallMode: { type: string };
      nsis: { installMode: string; installerHooks: string };
    };
    macOS: { signingIdentity: string | null; hardenedRuntime: boolean };
  };
}> {
  const path = new URL("../src-tauri/tauri.conf.json", import.meta.url);
  return JSON.parse(await Bun.file(path).text());
}
