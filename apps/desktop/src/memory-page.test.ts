import { expect, test } from "bun:test";

test("reflect now reloads observations, clears the status, and surfaces errors", async () => {
  const source = await Bun.file(
    new URL("../ui/memory.js", import.meta.url),
  ).text();
  const handler = source.slice(
    source.indexOf('getElementById("reflect-form")'),
  );
  expect(handler).toContain('reflectStatus.textContent = "Reflecting…";');
  expect(handler).toContain("await showObservations();");
  expect(handler).toContain('reflectStatus.textContent = "";');
  expect(handler).toContain("reflectStatus.textContent = messageOf(error);");
});
