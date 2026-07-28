import type { BaseGraph, CellValue, GraphDoc } from "../../types";
import { cellToId, edgeKey } from "../cells";
import { endpointId } from "../graph";

/**
 * The `graph` object a user script receives. Plain JSON: no methods, no live
 * references, nothing that would break crossing into the sandbox.
 */
export interface ScriptGraph {
  nodes: (Record<string, CellValue> & { id: string; degree: number })[];
  edges: (Record<string, CellValue> & { source: string; target: string })[];
  /** Undirected neighbour ids, which is what most scripts actually want. */
  neighbors: Record<string, string[]>;
  directed: boolean;
}

export function toScriptGraph(graph: BaseGraph, doc: GraphDoc): ScriptGraph {
  const neighbors: Record<string, string[]> = {};
  for (const node of graph.nodes) neighbors[node.id] = [];

  const edges: ScriptGraph["edges"] = [];
  for (const link of graph.links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    neighbors[source]?.push(target);
    neighbors[target]?.push(source);

    const row = link.rows[0] ?? {};
    const attrs: Record<string, CellValue> = {};
    for (const column of doc.edges.columns) {
      if (column.name === doc.mapping.source || column.name === doc.mapping.target) continue;
      attrs[column.name] = row[column.name] ?? null;
    }
    edges.push({ ...attrs, source, target });
  }

  const nodes: ScriptGraph["nodes"] = graph.nodes.map((node) => {
    const attrs: Record<string, CellValue> = {};
    for (const column of doc.nodes.columns) {
      if (column.name === doc.nodeIdColumn) continue;
      attrs[column.name] = node.row[column.name] ?? null;
    }
    return { ...attrs, id: node.id, degree: node.degree };
  });

  return { nodes, edges, neighbors, directed: true };
}

export type ScriptMode = "node" | "edge" | "layout";

export interface ScriptOutcome {
  /** Values keyed by node id, or by `edgeKey(source, target)`. */
  values?: Record<string, CellValue>;
  positions?: Record<string, { x: number; y: number }>;
}

/**
 * Validate and normalize whatever the script returned. Scripts are written by
 * hand and get this wrong constantly, so the message has to say what shape was
 * expected rather than failing somewhere downstream.
 */
export function interpretResult(mode: ScriptMode, raw: unknown): ScriptOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      mode === "layout"
        ? 'A layout script must return an object like { "Alex": { x: 0, y: 0 } }.'
        : 'A metric script must return an object like { "Alex": 1.5 }.',
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new Error("The script returned an empty object.");

  if (mode === "layout") {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, value] of entries) {
      const point = value as { x?: unknown; y?: unknown } | null;
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!isFinite(x) || !isFinite(y)) {
        throw new Error(`"${id}" needs numeric x and y; got ${JSON.stringify(value)}.`);
      }
      positions[id] = { x, y };
    }
    return { positions };
  }

  const values: Record<string, CellValue> = {};
  for (const [key, value] of entries) {
    if (value === null || typeof value === "number" || typeof value === "string") {
      values[key] = value;
    } else if (typeof value === "boolean") {
      values[key] = value;
    } else {
      throw new Error(`"${key}" must be a number, string or boolean; got ${typeof value}.`);
    }
  }
  return { values };
}

/** Edge scripts key their results by endpoint pair, which needs normalizing. */
export function normalizeEdgeKeys(values: Record<string, CellValue>): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const [key, value] of Object.entries(values)) {
    // Accept "a->b" as a friendlier alternative to the internal separator.
    const arrow = key.indexOf("->");
    if (arrow > 0) {
      const source = cellToId(key.slice(0, arrow));
      const target = cellToId(key.slice(arrow + 2));
      if (source !== null && target !== null) {
        out[edgeKey(source, target)] = value;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}
