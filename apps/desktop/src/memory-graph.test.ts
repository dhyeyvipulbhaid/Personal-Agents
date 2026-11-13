import { beforeEach, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../ui/memory-graph.js", import.meta.url),
).text();
// The page loads this file as a classic script. The test runs that same file.
const runGraph = new Function(
  `${source}; return globalThis.PersonalAgentsGraph;`,
) as () => {
  recencyColor(value: number): string;
  EDGE_COLORS: Record<string, string>;
  LEGEND: { id: string; label: string }[];
  createSimulation(
    snapshot: unknown,
    previous?: { positions?: Record<string, { x: number; y: number }> },
  ): Simulation;
};
const api = runGraph();

beforeEach(() => {
  globalThis.sessionStorage?.removeItem("pa-memory-graph-positions");
});

type Node = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Simulation = {
  nodes: Node[];
  step(): Node[];
  sync(snapshot: unknown): void;
  kinetic(): number;
  alpha(): number;
  isSettled(): boolean;
  reheat(amount?: number): void;
  setPaused(value: boolean): void;
  isPaused(): boolean;
  setEdgeEnabled(type: string, on: boolean): void;
  visibleEdges(): { type: string }[];
  panBy(dx: number, dy: number): void;
  zoomAt(factor: number, x: number, y: number): void;
  toScreen(x: number, y: number): { x: number; y: number };
  fit(width: number, height: number): void;
  radiusOf(node: Node): number;
  hit(x: number, y: number): { id: string } | null;
  moveNode(
    id: string,
    x: number,
    y: number,
    options?: { reheat?: boolean },
  ): void;
  view(): { zoom: number };
};

test("recency runs from slate to amber and the legend names four edges", () => {
  expect(api.recencyColor(0)).toBe("rgb(100, 116, 139)");
  expect(api.recencyColor(1)).toBe("rgb(217, 119, 6)");
  expect(api.EDGE_COLORS.semantic).toBeTruthy();
  expect(api.EDGE_COLORS.temporal).toBeTruthy();
  expect(api.EDGE_COLORS.entity).toBeTruthy();
  expect(api.EDGE_COLORS.derived).toBeTruthy();
  expect(api.LEGEND.map((item) => item.id)).toEqual([
    "recency",
    "semantic",
    "temporal",
    "entity",
    "derived",
  ]);
});

test("the graph pauses, filters edges, zooms, and hits a dragged node", () => {
  const simulation = api.createSimulation({
    nodes: [
      {
        id: "a",
        label: "Maya prefers morning meetings.",
        recency: 1,
        sourceFactCount: 1,
        derived: false,
      },
      {
        id: "b",
        label: "Maya writes the agenda.",
        recency: 0.2,
        sourceFactCount: 1,
        derived: false,
      },
    ],
    edges: [
      { source: "a", target: "b", type: "semantic", weight: 1 },
      { source: "a", target: "b", type: "temporal", weight: 1 },
      { source: "a", target: "b", type: "entity", weight: 1 },
      { source: "b", target: "a", type: "derived", weight: 1 },
    ],
  });
  const before = simulation.nodes.map((node) => [node.x, node.y]);
  simulation.step();
  const moved = simulation.nodes.map((node) => [node.x, node.y]);
  expect(moved).not.toEqual(before);
  simulation.setPaused(true);
  expect(simulation.isPaused()).toBe(true);
  const paused = simulation.nodes.map((node) => [node.x, node.y]);
  simulation.step();
  expect(simulation.nodes.map((node) => [node.x, node.y])).toEqual(paused);

  simulation.setEdgeEnabled("semantic", false);
  expect(
    simulation
      .visibleEdges()
      .map((edge) => edge.type)
      .sort(),
  ).toEqual(["derived", "entity", "temporal"]);

  simulation.moveNode("a", 12, 8);
  simulation.panBy(0, 0);
  expect(simulation.hit(12, 8)?.id).toBe("a");
  expect(simulation.hit(400, 400)).toBeNull();

  const start = simulation.toScreen(12, 8);
  simulation.zoomAt(2, 0, 0);
  expect(simulation.view().zoom).toBe(2);
  expect(simulation.toScreen(12, 8)).not.toEqual(start);
});

test("thirty nodes cool down and stay spread out", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({
    id: `n${index}`,
    label: `Fact ${index} about Maya`,
    recency: index / 30,
    sourceFactCount: 1,
    derived: false,
  }));
  const edges = nodes.map((node, index) => ({
    source: node.id,
    target: nodes[(index + 1) % nodes.length]?.id,
    type: "temporal",
    weight: 1,
  }));
  const simulation = api.createSimulation({ nodes, edges });
  const cooled = simulation.alpha();
  simulation.hit(0, 0);
  expect(simulation.alpha()).toBe(cooled);
  for (let tick = 0; tick < 500; tick += 1) {
    simulation.step();
  }
  expect(simulation.isSettled()).toBe(true);
  expect(simulation.kinetic()).toBeLessThan(0.05);
  const xs = simulation.nodes.map((node) => node.x);
  const ys = simulation.nodes.map((node) => node.y);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(40);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40);
  let nearest = Number.POSITIVE_INFINITY;
  for (let left = 0; left < simulation.nodes.length; left += 1) {
    for (let right = left + 1; right < simulation.nodes.length; right += 1) {
      const a = simulation.nodes[left];
      const b = simulation.nodes[right];
      if (!a || !b) {
        continue;
      }
      nearest = Math.min(nearest, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  expect(nearest).toBeGreaterThan(18);
});

test("twenty six facts render inside the viewport", () => {
  const nodes = Array.from({ length: 26 }, (_, index) => ({
    id: `fact-${index}`,
    label: `Restored fact ${index} stays on this machine`,
    recency: 0.4 + (index % 5) / 10,
    sourceFactCount: 1,
    derived: false,
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    source: nodes[index]?.id,
    target: node.id,
    type: "temporal",
    weight: 1,
  }));
  const simulation = api.createSimulation({ nodes, edges });
  for (let tick = 0; tick < 500 && !simulation.isSettled(); tick += 1) {
    simulation.step();
  }
  const width = 800;
  const height = 480;
  simulation.fit(width, height);
  let visible = 0;
  for (const node of simulation.nodes) {
    const point = simulation.toScreen(node.x, node.y);
    const screenX = width / 2 + point.x;
    const screenY = height / 2 + point.y;
    const radius = simulation.radiusOf(node);
    expect(Number.isFinite(screenX)).toBe(true);
    expect(Number.isFinite(screenY)).toBe(true);
    if (
      screenX >= radius &&
      screenX <= width - radius &&
      screenY >= radius &&
      screenY <= height - radius
    ) {
      visible += 1;
    }
  }
  expect(visible).toBe(26);
});

test("a refresh keeps placed nodes and only seeds new ones", () => {
  const snapshot = {
    nodes: [
      {
        id: "a",
        label: "Maya prefers morning meetings.",
        recency: 1,
        sourceFactCount: 1,
      },
      {
        id: "b",
        label: "Maya writes the agenda.",
        recency: 0.4,
        sourceFactCount: 1,
      },
    ],
    edges: [{ source: "a", target: "b", type: "entity", weight: 1 }],
  };
  const simulation = api.createSimulation(snapshot);
  for (let tick = 0; tick < 25; tick += 1) {
    simulation.step();
  }
  const placed = simulation.nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
  }));
  simulation.sync(snapshot);
  for (const node of placed) {
    const kept = simulation.nodes.find((item) => item.id === node.id);
    expect(kept?.x).toBe(node.x);
    expect(kept?.y).toBe(node.y);
  }
  simulation.sync({
    nodes: [
      ...snapshot.nodes,
      { id: "c", label: "A new fact.", recency: 1, sourceFactCount: 1 },
    ],
    edges: snapshot.edges,
  });
  const keptA = simulation.nodes.find((node) => node.id === "a");
  const fresh = simulation.nodes.find((node) => node.id === "c");
  expect(keptA?.x).toBe(placed.find((node) => node.id === "a")?.x);
  expect(fresh).toBeTruthy();
  expect(fresh?.x).not.toBe(keptA?.x);
  const again = api.createSimulation(snapshot, {
    positions: { a: { x: 40, y: -15 } },
  });
  expect(again.nodes.find((node) => node.id === "a")).toMatchObject({
    x: 40,
    y: -15,
  });
});
