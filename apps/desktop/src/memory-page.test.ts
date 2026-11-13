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
  expect(source).toContain("showGraphNote(detail)");
  const page = await Bun.file(
    new URL("../ui/memory.html", import.meta.url),
  ).text();
  expect(page).toContain('id="graph-status"');
  expect(page.indexOf("<h2>Graph</h2>")).toBeLessThan(
    page.indexOf('id="memory-settings"'),
  );
  expect(page.indexOf('id="graph-detail"')).toBeGreaterThan(
    page.indexOf('id="memory-graph"'),
  );
  expect(page.indexOf('id="graph-detail"')).toBeLessThan(
    page.indexOf('id="memory-settings"'),
  );
  const sweep = source.slice(
    source.indexOf('getElementById("sweep-apply")'),
    source.indexOf('getElementById("graph-toggle")'),
  );
  expect(sweep).toContain("showGraph()");
  const selected = source.slice(
    source.indexOf('getElementById("delete-selected")'),
    source.indexOf('getElementById("settings-form")'),
  );
  expect(selected).toContain("showGraph()");
  const one = source.slice(
    source.indexOf('invoke("memory_delete"'),
    source.indexOf('invoke("memory_update"'),
  );
  expect(one).toContain("showGraph()");
  expect(page).toContain('id="choice-passphrase-input" type="password"');
  expect(page).toContain('id="choice-passphrase-confirm" type="password"');
  expect(page).toContain('id="unlock-passphrase-input" type="password"');
  expect(source).toContain("passphraseProblem");
  expect(source).toContain(
    "setEncryptChecked(encrypt, settings.encryptionEnabled === true)",
  );
});
