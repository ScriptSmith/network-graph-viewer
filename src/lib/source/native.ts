import type { Dataset, GraphDoc, Row, Table } from "../../types";
import { cellKey, cellToId, compoundKey } from "../cells";
import { buildDoc, DEFAULT_NODE_ID_COLUMN } from "../doc";
import { compileCondition, compileWhere } from "../filter";
import { docIncidence } from "../graphIndex";
import { computeBins, numericValues } from "../histogram";
import { columnRange, distinctValues } from "../graph";
import type {
  DataSource,
  DistinctValue,
  EdgeSelection,
  Endpoints,
  HopCount,
  MaterializeResult,
  NeighborhoodCounts,
  NodeCount,
  NodeHit,
  SourceSchema,
} from "./types";

/**
 * The source over tables that are already in memory.
 *
 * It ships first and it is deliberately unremarkable: every answer is a pass
 * over rows the app could have walked itself. Its job is to keep the interface
 * honest. A vocabulary with one implementation is a description of that
 * implementation, and this is the implementation the contract suite runs
 * against under vitest (the engine is exercised by the SQL tests and by headed
 * sessions instead), so a question the native source cannot answer plainly is
 * a question the interface should not be asking.
 *
 * Nothing in the app constructs one today: a file small enough to hold opens
 * straight into a document. It stays because it is the reference the contract
 * reads against, and the shape a future in-memory or kernel source would take.
 */
export function nativeSource(dataset: Dataset): DataSource {
  const docs = new Map<string, GraphDoc>();

  const tableOf = (name: string): Table | undefined => dataset.tables.find((t) => t.name === name);

  const rowsOf = (name: string): Row[] => tableOf(name)?.rows ?? [];

  /**
   * The endpoint spec as a document, built once per spec. The walk then rides
   * the same incidence index the rest of the app uses, rather than growing a
   * second answer to what a neighbour is.
   */
  const docFor = (ends: Endpoints): GraphDoc | null => {
    const key = compoundKey(ends.table, ends.source, ends.target);
    const cached = docs.get(key);
    if (cached !== undefined) return cached;
    const table = tableOf(ends.table);
    if (table === undefined) return null;
    const doc = buildDoc(dataset.fileName, table, {
      mapping: { source: ends.source, target: ends.target, attrs: [] },
    });
    docs.set(key, doc);
    return doc;
  };

  /** Every predicate compiled once, then run per row. */
  const compilePredicates = (selection: EdgeSelection): ((row: Row) => boolean) | null => {
    const list = (selection.predicates ?? []).map((p) => ({
      column: p.column,
      test: compileCondition(p.op),
    }));
    if (list.length === 0) return null;
    return (row) => list.every((p) => p.test(row, p.column));
  };

  /**
   * The walk itself, shared by counting and materializing so the two can never
   * disagree about what the selection means.
   */
  const walk = (selection: EdgeSelection) => {
    const doc = docFor(selection);
    if (doc === null) return null;
    const { ids, index, offsets, neighbor, link, forward } = docIncidence(doc);
    const rows = doc.edges.rows;

    const predicate = compilePredicates(selection);
    const whereTest = compileWhere(selection.where);
    const whereColumn = selection.where?.column;
    const passes = (row: Row): boolean => predicate === null || predicate(row);
    const walkable = (e: number): boolean =>
      passes(rows[e]) &&
      (whereTest === null || whereColumn === undefined || whereTest(cellKey(rows[e][whereColumn])));

    const depthOf = new Int32Array(ids.length).fill(-1);
    const reached: number[] = [];
    const walked = new Set<number>();
    const hops: HopCount[] = [];
    let truncated = false;

    const reach = (id: string | null) => {
      const at = id === null ? undefined : index.get(id);
      if (at === undefined || depthOf[at] !== -1) return;
      depthOf[at] = 0;
      reached.push(at);
    };

    let frontier: number[] = [];
    if (selection.seeds.length === 0) {
      // No seeds means from the top: rows in file order until the budget is
      // met, which is what opening a source without naming a node asks for.
      // The scan still runs to the end, so the total is the rows the
      // constraint keeps rather than the size of the table they sit in.
      let total = 0;
      for (let e = 0; e < rows.length; e++) {
        if (!walkable(e)) continue;
        total++;
        if (walked.size >= selection.edgeLimit) continue;
        walked.add(e);
        reach(cellToId(rows[e][selection.source]));
        reach(cellToId(rows[e][selection.target]));
      }
      truncated = total > walked.size;
      hops.push({ depth: 0, nodes: reached.length });
      return { doc, ids, depthOf, reached, walked, hops, truncated, rows, passes, total };
    }

    for (const seed of selection.seeds) {
      const at = index.get(seed);
      if (at !== undefined && depthOf[at] === -1) {
        depthOf[at] = 0;
        reached.push(at);
        frontier.push(at);
      }
    }
    hops.push({ depth: 0, nodes: frontier.length });

    for (let hop = 0; hop < selection.depth && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const v of frontier) {
        for (let p = offsets[v]; p < offsets[v + 1]; p++) {
          if (selection.direction === "out" && forward[p] === 0) continue;
          if (selection.direction === "in" && forward[p] === 1) continue;
          const other = neighbor[p];
          if (depthOf[other] !== -1 && depthOf[other] !== hop + 1) continue;
          if (!walkable(link[p])) continue;
          if (depthOf[other] === -1) {
            depthOf[other] = hop + 1;
            reached.push(other);
            next.push(other);
          }
          walked.add(link[p]);
          // The budget is a hard ceiling: stop at the hop boundary rather than
          // returning a neighbourhood that is half of one depth.
          if (walked.size >= selection.edgeLimit) truncated = true;
        }
      }
      hops.push({ depth: hop + 1, nodes: next.length });
      if (truncated) break;
      frontier = next;
    }

    return { doc, ids, depthOf, reached, walked, hops, truncated, rows, passes, total: null };
  };

  /**
   * What the selection keeps: the rows, and the nodes.
   *
   * The nodes are carried rather than re-derived from the surviving rows,
   * because they are not the same set. A depth-0 selection reaches its seeds
   * and walks nothing, and a predicate can leave a node with no surviving
   * edges at all; both are answers, and deriving nodes from edges would turn
   * them into an empty graph.
   */
  const selected = (
    selection: EdgeSelection,
  ): {
    rows: Row[];
    total: number;
    nodes: string[];
    hops: HopCount[];
    truncated: boolean;
  } | null => {
    const found = walk(selection);
    if (found === null) return null;
    const { depthOf, ids, rows, walked, passes, reached, hops, truncated, total } = found;
    const nodes = reached.map((at) => ids[at]);

    let kept: Row[];
    if (selection.walkedOnly === true || selection.seeds.length === 0) {
      // From the top there is no induced set beyond the rows the scan kept, so
      // both switches land on the walked rows themselves.
      kept = [...walked].sort((a, b) => a - b).map((e) => rows[e]);
    } else {
      const inside = new Set<string>();
      for (let i = 0; i < ids.length; i++) if (depthOf[i] !== -1) inside.add(ids[i]);
      kept = [];
      for (let e = 0; e < rows.length; e++) {
        const s = cellToId(rows[e][selection.source]);
        const t = cellToId(rows[e][selection.target]);
        if (s === null || t === null || !inside.has(s) || !inside.has(t)) continue;
        // The walk constraint governed which edges the walk could step along;
        // it does not thin the neighbourhood that was found. Only the pushed
        // predicates keep filtering here, since a row they drop is a row the
        // working set must never hold.
        if (!passes(rows[e])) continue;
        kept.push(rows[e]);
      }
    }
    // From the top, what was on offer was every row the constraint keeps, so
    // that is what the shortfall is measured against; from a seed, it is the
    // neighbourhood.
    return {
      rows: kept.slice(0, selection.edgeLimit),
      total: total ?? kept.length,
      nodes,
      hops,
      truncated,
    };
  };

  return {
    kind: "native",

    async schema(): Promise<SourceSchema> {
      return {
        tables: dataset.tables.map((t) => ({
          name: t.name,
          columns: t.columns,
          rowCount: t.rows.length,
        })),
      };
    },

    async distinct(table, column, limit): Promise<DistinctValue[]> {
      return distinctValues(rowsOf(table), column)
        .slice(0, limit)
        .map((v) => ({ value: v.key, count: v.count }));
    },

    async range(table, column) {
      return columnRange(rowsOf(table), column);
    },

    async bins(table, column, count) {
      return computeBins(numericValues(rowsOf(table), column), count);
    },

    async nodeCount(ends): Promise<NodeCount> {
      const doc = docFor(ends);
      // In memory the exact answer is one pass, so there is nothing to
      // estimate and nothing to apologise for.
      return { value: doc === null ? 0 : docIncidence(doc).ids.length, approximate: false };
    },

    async searchNodes(ends, query, limit): Promise<NodeHit[]> {
      const doc = docFor(ends);
      if (doc === null) return [];
      const q = query.trim().toLowerCase();
      if (q === "") return [];
      const { ids } = docIncidence(doc);
      const starts: NodeHit[] = [];
      const contains: NodeHit[] = [];
      for (const id of ids) {
        const low = id.toLowerCase();
        if (low.startsWith(q)) {
          starts.push({ id, label: null });
          if (starts.length >= limit) break;
        } else if (contains.length < limit && low.includes(q)) {
          contains.push({ id, label: null });
        }
      }
      return [...starts, ...contains].slice(0, limit);
    },

    async lookupIds(ends, ids): Promise<string[]> {
      const doc = docFor(ends);
      if (doc === null || ids.length === 0) return [];
      const { index } = docIncidence(doc);
      const seen = new Set<string>();
      const found: string[] = [];
      for (const id of ids) {
        if (seen.has(id) || !index.has(id)) continue;
        seen.add(id);
        found.push(id);
      }
      return found;
    },

    searchMode() {
      // In memory every search is a lookup over an index already built.
      return "directory";
    },

    async neighborhood(selection): Promise<NeighborhoodCounts> {
      const kept = selected(selection);
      if (kept === null) return { hops: [], nodes: 0, edges: 0, truncated: false };
      return {
        hops: kept.hops,
        nodes: kept.nodes.length,
        edges: kept.rows.length,
        truncated: kept.truncated || kept.total > kept.rows.length,
      };
    },

    async materialize(selection): Promise<MaterializeResult> {
      const kept = selected(selection);
      const table = tableOf(selection.table);
      if (kept === null || table === undefined) {
        throw new Error(`No table named ${selection.table} in ${dataset.fileName}.`);
      }
      const edges: Table = { name: table.name, columns: table.columns, rows: kept.rows };
      const nodes: Table = {
        name: "Nodes",
        columns: [{ name: DEFAULT_NODE_ID_COLUMN, type: "text" }],
        rows: kept.nodes.map((id) => ({ [DEFAULT_NODE_ID_COLUMN]: id })),
      };
      const doc = buildDoc(dataset.fileName, edges, {
        nodes,
        mapping: { source: selection.source, target: selection.target, attrs: [] },
      });
      return {
        doc,
        hops: kept.hops,
        truncated:
          kept.total > kept.rows.length ? { read: kept.rows.length, total: kept.total } : undefined,
      };
    },

    dispose() {
      docs.clear();
    },
  };
}
