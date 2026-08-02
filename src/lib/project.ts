import type { GraphDoc, Row, Table } from "../types";
import { cellToId, edgeKey } from "./cells";

/**
 * One-mode projection of a bipartite edge list: keep one side, and link two
 * of its nodes wherever they share a counterpart on the other side, weighted
 * by how many counterparts they share. A pure `GraphDoc -> GraphDoc`
 * transform, so it lands in the undo history as one step and undo restores
 * the bipartite original.
 */

export type ProjectionSide = "source" | "target";

/**
 * Ceiling on generated pairs. The work is the sum over counterpart nodes of
 * their degree squared, so one counterpart with ten thousand neighbours means
 * fifty million pairs; past this the projection stops at a counterpart
 * boundary and says exactly how far it got, rather than silently thinning.
 */
export const PROJECTION_PAIR_LIMIT = 250_000;

export interface ProjectionReport {
  keep: ProjectionSide;
  /** Kept-side nodes that made it into the projected document. */
  nodes: number;
  /** Distinct projected links. */
  edges: number;
  /** Counterpart nodes folded in, against how many there were. */
  counterparts: { used: number; total: number };
}

/**
 * How many pairs the projection would generate, counted before doing it, so
 * a caller can warn or refuse while the answer is still cheap.
 */
export function projectionPairBound(doc: GraphDoc, keep: ProjectionSide): number {
  const degrees = counterpartNeighbours(doc, keep);
  let pairs = 0;
  for (const kept of degrees.values()) {
    pairs += (kept.length * (kept.length - 1)) / 2;
  }
  return pairs;
}

/** Distinct kept-side neighbours per counterpart node, in first-seen order. */
function counterpartNeighbours(doc: GraphDoc, keep: ProjectionSide): Map<string, string[]> {
  const { source, target } = doc.mapping;
  const keptColumn = keep === "source" ? source : target;
  const otherColumn = keep === "source" ? target : source;

  const neighbours = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const row of doc.edges.rows) {
    const kept = cellToId(row[keptColumn]);
    const other = cellToId(row[otherColumn]);
    if (kept === null || other === null) continue;
    let members = seen.get(other);
    if (!members) {
      members = new Set();
      seen.set(other, members);
      neighbours.set(other, []);
    }
    if (!members.has(kept)) {
      members.add(kept);
      (neighbours.get(other) as string[]).push(kept);
    }
  }
  return neighbours;
}

export function projectBipartite(
  doc: GraphDoc,
  keep: ProjectionSide,
  pairLimit = PROJECTION_PAIR_LIMIT,
): { doc: GraphDoc; report: ProjectionReport } {
  const neighbours = counterpartNeighbours(doc, keep);

  // Pairs are keyed by the kept ids' global first-appearance order, so the
  // same pair met under two counterparts lands on one link whichever way
  // each counterpart happened to list it.
  const appearance = new Map<string, number>();
  for (const kept of neighbours.values()) {
    for (const id of kept) {
      if (!appearance.has(id)) appearance.set(id, appearance.size);
    }
  }

  const counts = new Map<string, { a: string; b: string; count: number }>();
  let budget = pairLimit;
  let used = 0;
  for (const kept of neighbours.values()) {
    const pairs = (kept.length * (kept.length - 1)) / 2;
    // Stopping at a counterpart boundary keeps every written weight exact
    // for the counterparts that were folded in.
    if (pairs > budget) break;
    budget -= pairs;
    used++;
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const flip = (appearance.get(kept[i]) as number) > (appearance.get(kept[j]) as number);
        const a = flip ? kept[j] : kept[i];
        const b = flip ? kept[i] : kept[j];
        const key = edgeKey(a, b);
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { a, b, count: 1 });
      }
    }
  }

  const edgeRows: Row[] = [...counts.values()].map(({ a, b, count }) => ({
    Source: a,
    Target: b,
    "Shared count": count,
  }));
  const edges: Table = {
    name: "Projection",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "Shared count", type: "number" },
    ],
    rows: edgeRows,
  };

  // The kept side's node rows survive with their attributes; the other side's
  // rows have nothing to attach to any more and go.
  const keptColumn = keep === "source" ? doc.mapping.source : doc.mapping.target;
  const keptIds = new Set<string>();
  for (const row of doc.edges.rows) {
    const id = cellToId(row[keptColumn]);
    if (id !== null) keptIds.add(id);
  }
  const nodeRows = doc.nodes.rows.filter((row) => {
    const id = cellToId(row[doc.nodeIdColumn]);
    return id !== null && keptIds.has(id);
  });
  const nodes: Table = { ...doc.nodes, rows: nodeRows };

  const projected: GraphDoc = {
    name: doc.name,
    edges,
    nodes,
    nodeIdColumn: doc.nodeIdColumn,
    mapping: { source: "Source", target: "Target", attrs: ["Shared count"] },
    nodesDeclared: true,
  };

  return {
    doc: projected,
    report: {
      keep,
      nodes: nodeRows.length,
      edges: edgeRows.length,
      counterparts: { used, total: neighbours.size },
    },
  };
}
