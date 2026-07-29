import type { CellValue, Dataset, GraphStyle, Row, Table } from "../types";
import { guessMapping, inferColumns } from "../lib/parse";
import { cellKey } from "../lib/cells";

/** Build a table from a header list and positional tuples. */
export function table(
  name: string,
  columns: string[],
  raw: readonly (readonly CellValue[])[],
): Table {
  const rows: Row[] = raw.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  return { name, columns: inferColumns(rows, columns), rows };
}

/**
 * A network shipped with the app. The first table is always the edge list;
 * `nodeTable` names the one carrying node attributes, when there is one.
 */
export interface SampleNetwork {
  id: string;
  name: string;
  /** What the network is and what it is worth looking at it for. */
  blurb: string;
  dataset: Dataset;
  /** Index into `dataset.tables` of the node attribute table. */
  nodeTable?: number;
  /** Appearance worth starting from, merged over the guessed defaults. */
  style?: Partial<GraphStyle>;
  nodeCount: number;
  edgeCount: number;
}

export type SampleDefinition = Omit<SampleNetwork, "nodeCount" | "edgeCount">;

/**
 * Finish a definition by counting it. The counts are shown on the picker, so
 * they are derived from the data rather than written down beside it.
 */
export function sample(def: SampleDefinition): SampleNetwork {
  const edges = def.dataset.tables[0];
  const nodes = def.nodeTable === undefined ? null : def.dataset.tables[def.nodeTable];
  let nodeCount = nodes?.rows.length ?? 0;
  if (!nodes) {
    const mapping = guessMapping(edges);
    const ids = new Set<string>();
    for (const row of edges.rows) {
      for (const column of [mapping.source, mapping.target]) {
        const id = cellKey(row[column]);
        if (id !== "") ids.add(id);
      }
    }
    nodeCount = ids.size;
  }
  return { ...def, nodeCount, edgeCount: edges.rows.length };
}
