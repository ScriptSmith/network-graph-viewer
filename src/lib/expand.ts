import type { GraphDoc } from "../types";
import { cellKey, cellToId } from "./cells";
import { hasColumn } from "./doc";
import { docIncidence } from "./graphIndex";

/**
 * What one more hop from a node would bring in: the neighbours the current
 * subgraph does not show yet, counted by kind. Computed when the preview
 * opens, one pass over the edge rows, never in the render path.
 */

export interface ExpansionPreview {
  /** Distinct not-yet-visible neighbours one hop out. */
  total: number;
  /** Those neighbours by the node type column's value, biggest first. */
  byNodeType: { kind: string; count: number }[];
  /** The connecting edges by the edge type column's value, biggest first. */
  byEdgeType: { kind: string; count: number }[];
}

const sorted = (counts: Map<string, number>) =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count }));

export function expansionPreview(
  doc: GraphDoc,
  visible: ReadonlySet<string>,
  center: string,
  nodeTypeColumn: string | null,
  edgeTypeColumn: string | null,
): ExpansionPreview {
  // The type of an arriving node: its own row's cell when the node table
  // carries the column, else the naming edge row's, matching how the styling
  // projects a type onto a node the table never described.
  const onNodeTable = nodeTypeColumn !== null && hasColumn(doc.nodes, nodeTypeColumn);
  const nodeRow = new Map<string, (typeof doc.nodes.rows)[number]>();
  if (onNodeTable) {
    for (const row of doc.nodes.rows) {
      const id = cellToId(row[doc.nodeIdColumn]);
      if (id !== null && !nodeRow.has(id)) nodeRow.set(id, row);
    }
  }

  const arrivals = new Set<string>();
  const byNodeType = new Map<string, number>();
  const byEdgeType = new Map<string, number>();

  // Only the rows naming the centre are read, rather than all of them. The
  // index fills a node's entries in row order, so first-arrival still picks
  // the same naming row it picked when this scanned the table.
  const { ids, index, offsets, neighbor, link } = docIncidence(doc);
  const at = index.get(center);
  if (at === undefined) {
    return { total: 0, byNodeType: [], byEdgeType: [] };
  }

  for (let p = offsets[at]; p < offsets[at + 1]; p++) {
    const other = ids[neighbor[p]];
    if (other === center || visible.has(other)) continue;
    const row = doc.edges.rows[link[p]];

    if (edgeTypeColumn !== null) {
      const kind = cellKey(row[edgeTypeColumn]);
      byEdgeType.set(kind, (byEdgeType.get(kind) ?? 0) + 1);
    }
    if (arrivals.has(other)) continue;
    arrivals.add(other);
    if (nodeTypeColumn !== null) {
      const cell = onNodeTable ? nodeRow.get(other)?.[nodeTypeColumn] : row[nodeTypeColumn];
      const kind = cellKey(cell ?? null);
      byNodeType.set(kind, (byNodeType.get(kind) ?? 0) + 1);
    }
  }

  return { total: arrivals.size, byNodeType: sorted(byNodeType), byEdgeType: sorted(byEdgeType) };
}
