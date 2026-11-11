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
  bundle: {
    active: boolean;
    publisher: string;
    targets: string[];
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
