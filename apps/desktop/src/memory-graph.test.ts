import { expect, test } from "bun:test";

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
  createSimulation(snapshot: unknown): Simulation;
};
const api = runGraph();

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
  setPaused(value: boolean): void;
  isPaused(): boolean;
  setEdgeEnabled(type: string, on: boolean): void;
  visibleEdges(): { type: string }[];
  panBy(dx: number, dy: number): void;
  zoomAt(factor: number, x: number, y: number): void;
  toScreen(x: number, y: number): { x: number; y: number };
  hit(x: number, y: number): { id: string } | null;
  moveNode(id: string, x: number, y: number): void;
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
