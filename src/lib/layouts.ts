import type { Graph, GraphNode, LayoutId } from "../types";

export interface Point {
  x: number;
  y: number;
}

/**
 * Compute target positions for the static layouts, or null for the force
 * layout (which has no targets, only physics). Coordinates are centered on
 * the origin; the canvas fits the view afterwards.
 */
export function computeTargets(layout: LayoutId, graph: Graph): Map<string, Point> | null {
  switch (layout) {
    case "force":
      return null;
    case "circle":
      return circleLayout(graph);
    case "grid":
      return gridLayout(graph);
    case "hierarchy":
      return hierarchyLayout(graph);
    case "radial":
      return radialLayout(graph);
  }
}

function linkEnds(graph: Graph): [string, string][] {
  return graph.links.map((l) => [
    typeof l.source === "string" ? l.source : l.source.id,
    typeof l.target === "string" ? l.target : l.target.id,
  ]);
}

/** BFS depth from the roots, tolerating cycles and disconnected islands. */
export function nodeDepths(graph: Graph): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const [s, t] of linkEnds(graph)) {
    const list = children.get(s) ?? [];
    list.push(t);
    children.set(s, list);
  }

  const depths = new Map<string, number>();
  const queue: string[] = [];
  const roots = graph.nodes.filter((n) => n.inDegree === 0);
  for (const r of roots) {
    depths.set(r.id, 0);
    queue.push(r.id);
  }

  const visit = () => {
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const d = depths.get(id) as number;
      for (const child of children.get(id) ?? []) {
        if (!depths.has(child)) {
          depths.set(child, d + 1);
          queue.push(child);
        }
      }
    }
  };
  visit();

  // Cycles or islands with no in-degree-0 node: seed from the strongest
  // remaining broadcaster until everyone has a depth.
  while (depths.size < graph.nodes.length) {
    const remaining = graph.nodes.filter((n) => !depths.has(n.id));
    const seed = remaining.reduce((a, b) =>
      b.outDegree - b.inDegree > a.outDegree - a.inDegree ? b : a,
    );
    depths.set(seed.id, 0);
    queue.push(seed.id);
    visit();
  }
  return depths;
}

function circleLayout(graph: Graph): Map<string, Point> {
  const nodes = [...graph.nodes].sort(
    (a, b) => (a.group ?? "￿").localeCompare(b.group ?? "￿") || b.degree - a.degree,
  );
  const n = nodes.length;
  const radius = Math.max(150, (n * 42) / (2 * Math.PI));
  const targets = new Map<string, Point>();
  nodes.forEach((node, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    targets.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });
  return targets;
}

function gridLayout(graph: Graph): Map<string, Point> {
  const nodes = [...graph.nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const n = nodes.length;
  const cols = Math.ceil(Math.sqrt(n * 1.4));
  const spacing = 92;
  const rowCount = Math.ceil(n / cols);
  const targets = new Map<string, Point>();
  nodes.forEach((node, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    targets.set(node.id, {
      x: (col - (cols - 1) / 2) * spacing,
      y: (row - (rowCount - 1) / 2) * spacing,
    });
  });
  return targets;
}

function layerNodes(graph: Graph): GraphNode[][] {
  const depths = nodeDepths(graph);
  const layers: GraphNode[][] = [];
  for (const node of graph.nodes) {
    const d = depths.get(node.id) ?? 0;
    (layers[d] ??= []).push(node);
  }
  return layers.filter((l) => l.length > 0);
}

/** One barycenter pass: order each layer by the mean index of its parents. */
function sortByParents(layers: GraphNode[][], graph: Graph): void {
  const parents = new Map<string, string[]>();
  for (const [s, t] of linkEnds(graph)) {
    const list = parents.get(t) ?? [];
    list.push(s);
    parents.set(t, list);
  }
  for (let d = 1; d < layers.length; d++) {
    const prevIndex = new Map(layers[d - 1].map((n, i) => [n.id, i]));
    const score = (n: GraphNode) => {
      const ps = (parents.get(n.id) ?? [])
        .map((p) => prevIndex.get(p))
        .filter((i): i is number => i !== undefined);
      return ps.length > 0 ? ps.reduce((a, b) => a + b, 0) / ps.length : layers[d - 1].length / 2;
    };
    layers[d].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
  }
}

function hierarchyLayout(graph: Graph): Map<string, Point> {
  const layers = layerNodes(graph);
  sortByParents(layers, graph);
  const targets = new Map<string, Point>();
  const rowGap = 130;
  const totalHeight = (layers.length - 1) * rowGap;
  layers.forEach((layer, d) => {
    const gap = Math.max(70, Math.min(150, 1100 / layer.length));
    layer.forEach((node, i) => {
      targets.set(node.id, {
        x: (i - (layer.length - 1) / 2) * gap,
        y: d * rowGap - totalHeight / 2,
      });
    });
  });
  return targets;
}

function radialLayout(graph: Graph): Map<string, Point> {
  const layers = layerNodes(graph);
  sortByParents(layers, graph);
  const targets = new Map<string, Point>();
  const ringGap = 140;
  layers.forEach((layer, d) => {
    if (d === 0 && layer.length === 1) {
      targets.set(layer[0].id, { x: 0, y: 0 });
      return;
    }
    const radius = Math.max(d * ringGap, (layer.length * 40) / (2 * Math.PI));
    layer.forEach((node, i) => {
      const angle = (i / layer.length) * 2 * Math.PI - Math.PI / 2;
      targets.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    });
  });
  return targets;
}
