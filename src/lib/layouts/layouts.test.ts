import { expect, test } from "vitest";
import { forceSimulation } from "d3-force";
import type { BaseGraph, GraphLink, GraphNode } from "../../types";
import { circlePackLayout } from "./circlepack";
import { forceAtlas2 } from "./forceatlas2";
import { noverlap, noverlapPass } from "./noverlap";
import { computeTargets, defaultParams, forceAtlas2Params, LAYOUTS } from "./index";

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
