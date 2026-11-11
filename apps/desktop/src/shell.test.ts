import { expect, test } from "bun:test";
import { SHELL_ID } from "./shell.ts";

test("tauri config is version 2 and uses the shell id", async () => {
  const path = new URL("../src-tauri/tauri.conf.json", import.meta.url);
  const config = JSON.parse(await Bun.file(path).text()) as {
    $schema: string;
    identifier: string;
  };

  expect(config.$schema).toContain("/config/2");
  expect(config.identifier).toBe(SHELL_ID);
});
