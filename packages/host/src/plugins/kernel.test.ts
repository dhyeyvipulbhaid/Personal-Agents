import { expect, test } from "bun:test";
import { HELLO_PLUGIN_SOURCE } from "./hello.ts";
import { PluginKernel } from "./kernel.ts";
import { validateManifest } from "./manifest.ts";

test("a manifest names the core version, tile, schedule, and effects", () => {
  const manifest = validateManifest(
    {
      id: "sample",
      name: "Sample",
      version: "1.2.3",
      minCoreVersion: "0.0.0",
      tile: { title: "Sample" },
      schedule: { everyMs: 60_000 },
      effects: ["tile", "schedule"],
    },
    "0.0.0",
  );

  expect(manifest.minCoreVersion).toBe("0.0.0");
  expect(manifest.tile).toEqual({ title: "Sample" });
  expect(manifest.schedule).toEqual({ everyMs: 60_000 });
  expect(manifest.effects).toEqual(["tile", "schedule"]);
});

test("a plugin that needs a newer core is rejected", () => {
  expect(() =>
    validateManifest(
      {
        id: "future",
        name: "Future",
        version: "0.0.1",
        minCoreVersion: "9.0.0",
        effects: ["tile"],
        tile: { title: "Future" },
      },
      "0.0.0",
    ),
  ).toThrow(/newer core/);
});

test("unloading a plugin leaves zero registrations", async () => {
  const kernel = new PluginKernel();
  await kernel.load(sampleSource);

  expect(kernel.registrations()).toHaveLength(2);

  kernel.unload("sample");

  expect(kernel.registrations()).toEqual([]);
  expect(kernel.tiles()).toEqual([]);
});

test("a plugin that calls fetch is blocked", async () => {
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      hits += 1;
      return new Response("no");
    },
  });
  const kernel = new PluginKernel();
  try {
    const port = server.port ?? 0;
    await expect(kernel.load(fetchSource(port))).rejects.toThrow(
      /network is blocked/,
    );
    expect(hits).toBe(0);
    expect(kernel.registrations()).toEqual([]);
  } finally {
    await server.stop(true);
    kernel.close();
  }
});

test("a plugin that hangs past its timeout is stopped and marked unhealthy", async () => {
  const kernel = new PluginKernel({ callTimeoutMs: 200 });
  const started = Date.now();

  await expect(kernel.load(hangSource)).rejects.toThrow(/timed out/);

  expect(Date.now() - started).toBeLessThan(2_000);
  expect(kernel.health("hang")).toBe("unhealthy");
  expect(kernel.registrations()).toEqual([]);
  kernel.close();
});

test("the hello plugin contributes one themed tile", async () => {
  const kernel = new PluginKernel();
  await kernel.load(HELLO_PLUGIN_SOURCE);

  expect(kernel.health("hello")).toBe("healthy");
  const tiles = kernel.tiles();
  expect(tiles).toHaveLength(1);
  expect(tiles[0]?.title).toBe("Hello");
  expect(tiles[0]?.html).toContain('data-theme="__PA_THEME__"');
  expect(tiles[0]?.html).toContain(">Hello<");
  kernel.unload("hello");
  expect(kernel.registrations()).toEqual([]);
});

const sampleSource = `
export const manifest = {
  id: "sample",
  name: "Sample",
  version: "0.0.1",
  minCoreVersion: "0.0.0",
  tile: { title: "Sample" },
  schedule: { everyMs: 60000 },
  effects: ["tile", "schedule"]
};
export function apply(ctx) {
  ctx.register({
    effect: "tile",
    id: "sample",
    title: "Sample",
    html: "<p data-theme=\\"__PA_THEME__\\">Sample</p>"
  });
  ctx.register({ effect: "schedule", everyMs: 60000 });
}
`;

function fetchSource(port: number): string {
  return `
export const manifest = {
  id: "net",
  name: "Net",
  version: "0.0.1",
  minCoreVersion: "0.0.0",
  tile: { title: "Net" },
  effects: ["tile"]
};
export async function apply() {
  await fetch("http://127.0.0.1:${port}/secret");
}
`;
}

const hangSource = `
export const manifest = {
  id: "hang",
  name: "Hang",
  version: "0.0.1",
  minCoreVersion: "0.0.0",
  tile: { title: "Hang" },
  effects: ["tile"]
};
export function apply() {
  while (true) {}
}
`;
