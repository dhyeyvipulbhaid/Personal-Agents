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

  expect(config.productName).toBe("Personal Agents");
  expect(html).toContain(config.productName);
  expect(html).toContain(`Version ${config.version}`);
  expect(config.mainBinaryName).toBe("personal-agents");
  expect(config.build.frontendDist).toBe("../ui");
  expect(config.build.devUrl).toBeUndefined();
});

test("the window can ask for the host version", async () => {
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

  expect(html).toContain('id="host-version"');
  expect(html).toContain('src="main.js"');
  expect(script).toContain('invoke("host_version")');
  expect(script).toContain("Agent host ");
  expect(script).toContain('invoke("note_displayed_host_version"');
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

  expect(html).toContain('id="theme"');
  expect(html).toContain('value="system"');
  expect(html).toContain('value="light"');
  expect(html).toContain('value="dark"');
  expect(html).toContain("Follow system");
  expect(html).toContain('id="widgets"');
  expect(script).toContain('invoke("widgets")');
  expect(script).toContain('setAttribute("sandbox", "")');
  expect(script).toContain("__PA_THEME__");
  expect(config.app.security.csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(capabilities.permissions).toContain("allow-widgets");
  expect(build).toContain("widgets");
  expect(html).toContain('id="ollama-status"');
  expect(html).toContain('href="activity.html"');
  expect(html).toContain('href="approvals.html"');
  expect(script).toContain('invoke("ollama_status")');
  expect(script).toContain("https://ollama.com/download");
  expect(capabilities.permissions).toContain("allow-ollama-status");
  expect(capabilities.permissions).toContain("allow-audit-log");
  expect(capabilities.permissions).toContain("allow-approvals");
  expect(capabilities.permissions).toContain("allow-approval-act");
  expect(build).toContain("audit_log");
  expect(build).toContain("approval_act");
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
