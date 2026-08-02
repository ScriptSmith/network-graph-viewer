import { expect, test } from "vitest";
import { forceSimulation } from "d3-force";
import type { BaseGraph, GraphLink, GraphNode } from "../../types";
import { circlePackLayout } from "./circlepack";
import { forceAtlas2 } from "./forceatlas2";
import { labelNoverlap, noverlap, noverlapPass } from "./noverlap";
import { computeTargets, defaultParams, forceAtlas2Params, LAYOUTS } from "./index";
import { mercator, projectGeo, MERCATOR_LAT_LIMIT } from "./geo";

function node(id: string, radius = 8, group?: string): GraphNode {
  return {
    id,
    label: id,
    row: { Id: id, Team: group ?? "" },
    group: group ?? null,
    value: null,
    color: null,
    image: null,
    inDegree: 0,
    outDegree: 0,
    degree: 1,
    radius,
  };
}

function graphOf(nodes: GraphNode[]): BaseGraph {
  return { nodes, links: [], rows: [], skippedRows: 0 };
}

/** True when no two node circles overlap, allowing for float slop. */
function noOverlaps(nodes: GraphNode[], margin = 0): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const distance = Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
      if (distance < a.radius + b.radius + margin - 1e-6) return false;
    }
  }
  return true;
}

test("every layout in the registry has usable defaults", () => {
  const graph = graphOf(["a", "b", "c", "d"].map((id) => node(id)));
  for (const layout of LAYOUTS) {
    const targets = computeTargets(layout.id, defaultParams(layout.id), graph);
    if (layout.positions !== "computed") {
      // Physics layouts have no targets, and external ones get theirs from
      // whoever ran the script, not from here.
      expect(targets, `${layout.id} should not compute targets`).toBeNull();
    } else {
      expect(targets, `${layout.id} produced targets`).not.toBeNull();
      expect(targets?.size, `${layout.id} placed every node`).toBe(graph.nodes.length);
      for (const point of targets?.values() ?? []) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      }
    }
  }
});

test("circle packing separates the discs and never overlaps a node", () => {
  const nodes = [
    node("a1", 10, "red"),
    node("a2", 8, "red"),
    node("a3", 6, "red"),
    node("b1", 12, "blue"),
    node("b2", 5, "blue"),
  ];
  const targets = circlePackLayout(graphOf(nodes), { groupBy: "Team", padding: 4 });
  for (const n of nodes) {
    const point = targets.get(n.id);
    n.x = point?.x;
    n.y = point?.y;
  }
  expect(noOverlaps(nodes)).toBe(true);

  // Same-group nodes should end up nearer each other than the group centres are.
  const distance = (a: GraphNode, b: GraphNode) =>
    Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
  expect(distance(nodes[0], nodes[1])).toBeLessThan(distance(nodes[0], nodes[3]));
});

test("circle packing is deterministic", () => {
  const build = () => graphOf(["a", "b", "c", "d", "e"].map((id, i) => node(id, 5 + i)));
  const first = circlePackLayout(build(), { groupBy: "", padding: 2 });
  const second = circlePackLayout(build(), { groupBy: "", padding: 2 });
  expect([...first.entries()]).toEqual([...second.entries()]);
});

test("noverlap separates a pile of coincident nodes", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => node(id, 10));
  for (const n of nodes) {
    n.x = 0;
    n.y = 0;
  }
  noverlap(nodes, { margin: 4, speed: 0.8 });
  expect(noOverlaps(nodes, 3)).toBe(true);
});

/**
 * A hub is what breaks a naive integrator: it feels one pull per edge, so the
 * step it takes overshoots by more the more edges it has. This graph gives
 * three hubs 40 leaves each and cross-links them, which the pre-adaptive-speed
 * force sent past 1e100 within a hundred ticks and to Infinity soon after —
 * and an infinite coordinate hangs d3-quadtree's `cover` outright.
 */
function hubGraph(): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const link = (source: GraphNode, target: GraphNode) =>
    links.push({
      source,
      target,
      rows: [],
      weight: null,
      colorValue: null,
      color: null,
      width: null,
      curve: false,
    });

  const hubs = ["h0", "h1", "h2"].map((id) => node(id));
  nodes.push(...hubs);
  for (const [i, hub] of hubs.entries()) {
    for (let j = 0; j < 40; j++) {
      const leaf = node(`${hub.id}-${j}`);
      nodes.push(leaf);
      link(hub, leaf);
    }
    link(hub, hubs[(i + 1) % hubs.length]);
  }
  for (const n of nodes) n.degree = links.filter((l) => l.source === n || l.target === n).length;
  return { nodes, links };
}

test("ForceAtlas2 stays finite on a hub-heavy graph", () => {
  const { nodes, links } = hubGraph();
  const sim = forceSimulation<GraphNode, GraphLink>(nodes).velocityDecay(0.45).stop();
  sim.force("fa2", forceAtlas2(links, forceAtlas2Params(defaultParams("forceatlas2")), null));

  // Held at full alpha, the way a drag or a slider kick holds the real
  // simulation, so nothing here is rescued by alpha decay.
  for (let i = 0; i < 400; i++) {
    sim.alpha(1);
    sim.tick(1);
  }

  let extent = 0;
  for (const n of nodes) {
    expect(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} left the plane`).toBe(true);
    extent = Math.max(extent, Math.abs(n.x ?? 0), Math.abs(n.y ?? 0));
  }
  // Loose, but four orders of magnitude below where the old force ended up.
  expect(extent).toBeLessThan(50_000);

  // And it has settled rather than merely stayed bounded: a tick moves nodes
  // by a fraction of the layout, not by the whole of it.
  let move = 0;
  for (const n of nodes) move = Math.max(move, Math.hypot(n.vx ?? 0, n.vy ?? 0));
  expect(move).toBeLessThan(extent / 100);
});

test("noverlap leaves an already-clear layout alone", () => {
  const nodes = ["a", "b", "c"].map((id, i) => {
    const n = node(id, 6);
    n.x = i * 200;
    n.y = 0;
    return n;
  });
  expect(noverlapPass(nodes, { margin: 4, speed: 0.8 })).toBe(false);
  expect(nodes.map((n) => n.x)).toEqual([0, 200, 400]);
});

/** Whether two labelled footprints are clear of each other on some axis. */
function labelBoxesClear(a: GraphNode, b: GraphNode, labelChars: number): boolean {
  const hw = Math.max(a.radius, (labelChars * 6.4) / 2);
  const hh = (a.radius + 6 + 14 + a.radius) / 2;
  const cy = (a.radius + 6 + 14 - a.radius) / 2;
  const dx = Math.abs((b.x ?? 0) - (a.x ?? 0));
  const dy = Math.abs((b.y ?? 0) - cy - ((a.y ?? 0) - cy));
  return dx >= hw * 2 || dy >= hh * 2;
}

test("labelNoverlap separates a labelled pair whose discs never touched", () => {
  const a = node("a long node name here", 8);
  const b = node("b equally long name!!", 8);
  a.x = 0;
  a.y = 0;
  b.x = 40; // discs clear at 40px apart, 21-character labels are not
  b.y = 0;
  expect(labelBoxesClear(a, b, 21)).toBe(false);
  labelNoverlap(
    [a, b],
    new Map([
      [a.id, a.id],
      [b.id, b.id],
    ]),
  );
  expect(labelBoxesClear(a, b, 21)).toBe(true);
});

test("labelNoverlap holds a pinned node still and moves the other", () => {
  const a = node("pinned with a long label", 8);
  const b = node("free node with long name", 8);
  a.x = 0;
  a.y = 0;
  b.x = 30;
  b.y = 0;
  labelNoverlap(
    [a, b],
    new Map([
      [a.id, a.id],
      [b.id, b.id],
    ]),
    new Set([a.id]),
  );
  expect(a.x).toBe(0);
  expect(a.y).toBe(0);
  expect(Math.abs(b.x ?? 0) + Math.abs(b.y ?? 0)).toBeGreaterThan(30);
  expect(labelBoxesClear(a, b, 24)).toBe(true);
});

test("labelNoverlap leaves clearly separated labels alone", () => {
  const a = node("a", 8);
  const b = node("b", 8);
  a.x = 0;
  a.y = 0;
  b.x = 400;
  b.y = 0;
  labelNoverlap(
    [a, b],
    new Map([
      [a.id, "a"],
      [b.id, "b"],
    ]),
  );
  expect(a.x).toBe(0);
  expect(b.x).toBe(400);
});

test("unlabelled nodes still block a label from landing on them", () => {
  const labelled = node("wearing a very long label", 8);
  const plain = node("z-plain", 8);
  labelled.x = 0;
  labelled.y = 0;
  // Sitting right where the label is drawn: above the labelled disc.
  plain.x = 0;
  plain.y = -18;
  labelNoverlap([labelled, plain], new Map([[labelled.id, labelled.id]]));
  const gapX = Math.abs((plain.x ?? 0) - (labelled.x ?? 0));
  const gapY = Math.abs((plain.y ?? 0) - (labelled.y ?? 0));
  expect(Math.max(gapX, gapY)).toBeGreaterThan(18);
});

test("mercator pins the equator, clamps the poles, and points north up", () => {
  expect(mercator(0, 0).x).toBeCloseTo(0, 12);
  expect(mercator(0, 0).y).toBeCloseTo(0, 12);
  // North is negative y on screen, and further north is further negative.
  expect(mercator(45, 0).y).toBeLessThan(0);
  expect(mercator(-45, 0).y).toBeGreaterThan(0);
  expect(mercator(60, 0).y).toBeLessThan(mercator(45, 0).y);
  // The poles clamp to the projection's usable band instead of running away.
  expect(isFinite(mercator(90, 0).y)).toBe(true);
  expect(mercator(90, 0).y).toBeCloseTo(mercator(MERCATOR_LAT_LIMIT, 0).y, 10);
  // Longitude is linear.
  expect(mercator(0, 90).x).toBeCloseTo(Math.PI / 2, 10);
});

test("projectGeo places coordinates and parks the rows without any", () => {
  const nodes = [node("london"), node("sydney"), node("nowhere"), node("badlat")];
  nodes[0].row = { Id: "london", Lat: 51.5, Lon: -0.12 };
  nodes[1].row = { Id: "sydney", Lat: -33.87, Lon: 151.2 };
  nodes[2].row = { Id: "nowhere", Lat: null, Lon: null };
  nodes[3].row = { Id: "badlat", Lat: 200, Lon: 10 };
  const { targets, parked } = projectGeo(graphOf(nodes), "Lat", "Lon");

  expect(parked).toEqual(["nowhere", "badlat"]);
  const london = targets.get("london") as { x: number; y: number };
  const sydney = targets.get("sydney") as { x: number; y: number };
  // West of Sydney and north of it, which on screen is left and up.
  expect(london.x).toBeLessThan(sydney.x);
  expect(london.y).toBeLessThan(sydney.y);

  // Parked rows sit below everything that was placed.
  const placedBottom = Math.max(london.y, sydney.y);
  for (const id of parked) {
    expect((targets.get(id) as { y: number }).y).toBeGreaterThan(placedBottom);
  }
});

test("projectGeo with nothing placeable still parks every node", () => {
  const nodes = [node("a"), node("b")];
  nodes[0].row = { Id: "a" };
  nodes[1].row = { Id: "b" };
  const { targets, parked } = projectGeo(graphOf(nodes), "Lat", "Lon");
  expect(parked).toEqual(["a", "b"]);
  expect(targets.size).toBe(2);
});
