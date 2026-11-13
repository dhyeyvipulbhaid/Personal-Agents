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
});
