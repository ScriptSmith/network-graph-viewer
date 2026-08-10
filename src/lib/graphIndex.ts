import type { BaseGraph, GraphDoc, GraphNode, Row } from "../types";
import { cellToId } from "./cells";

/**
 * Spelled out here rather than imported from graph.ts, which imports this: an
 * endpoint is a string before the simulation runs and the node object after,
 * and that one line is not worth a cycle between the two modules.
 */
const endpointId = (e: string | GraphNode): string => (typeof e === "string" ? e : e.id);

/**
 * One incidence index per graph, shared by everything that used to build its
 * own.
 *
 * Seven places each walked every link to make a neighbour map: the ego walk,
 * the component count, the metric projection, the script payload, the canvas's
 * dimming and keyboard model, the expansion preview and the projection. They
 * are still seven questions, but they are now asked of one answer.
 *
 * There are two levels, because the consumers genuinely live at two. Most of
 * them hold a `BaseGraph`, the subgraph the filter chain produced, whose links
 * have already merged the rows behind them; a doc-keyed index would only ever
 * have served the unfiltered case. The expansion preview and the seed search
 * are the other kind: they ask about the whole document precisely because it
 * is bigger than what is on screen.
 *
 * Both levels are lazy and cached in `WeakMap`s keyed on the thing they
 * describe, so `applyChain` building a graph per enabled step costs nothing
 * for the intermediates nobody asks about, and an index dies with its graph.
 *
 * **Neighbour order is link order, and has to stay that way.** Louvain runs in
 * index order so that its results are reproducible, the golden snapshot is
 * seeded from the original pipeline, and a user script reads `graph.neighbors`
 * as a list. Filling the arrays by walking the links once and appending to
 * both endpoints is what reproduces the order the hand-built maps had.
 */

/** Ids interned to dense integers, in the order the graph declares them. */
export interface Interner {
  ids: string[];
  index: ReadonlyMap<string, number>;
}

/**
 * Incidence in compressed-sparse-row form over interned ids.
 *
 * Every link contributes two entries, one owned by each endpoint, so walking
 * `offsets[v]` to `offsets[v + 1]` visits each link incident to `v` once.
 * `forward` says which way round that entry is, which is what lets one
 * undirected structure answer the directed questions too: a self-loop is two
 * entries the same way the hand-built maps pushed it twice.
 */
export interface Incidence {
  /** `n + 1` boundaries: node `v` owns `offsets[v]` up to `offsets[v + 1]`. */
  offsets: Int32Array;
  /** The other end of each entry, interned. */
  neighbor: Int32Array;
  /** Which link (or, at document level, which edge row) the entry came from. */
  link: Int32Array;
  /** 1 when the owning node is that link's source, 0 when it is the target. */
  forward: Uint8Array;
}

interface GraphEntry {
  interner: Interner;
  incidence?: Incidence;
}

const graphs = new WeakMap<BaseGraph, GraphEntry>();

function entryOf(base: BaseGraph): GraphEntry {
  let entry = graphs.get(base);
  if (entry === undefined) {
    const ids = base.nodes.map((n) => n.id);
    const index = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) index.set(ids[i], i);
    entry = { interner: { ids, index } };
    graphs.set(base, entry);
  }
  return entry;
}

/**
 * The graph's node ids as dense integers. `toMetricGraph` takes its `ids` and
 * its lookup from here rather than deriving them again, which is also what
 * lets the metric form answer "which index is this id" without a linear scan.
 */
export function nodeIndex(base: BaseGraph): Interner {
  return entryOf(base).interner;
}

/** The graph's incidence, built the first time something asks for it. */
export function incidenceOf(base: BaseGraph): Incidence {
  const entry = entryOf(base);
  if (entry.incidence === undefined) {
    const { index } = entry.interner;
    const ends: Ends[] = new Array(base.links.length);
    for (let e = 0; e < base.links.length; e++) {
      const link = base.links[e];
      const s = index.get(endpointId(link.source));
      const t = index.get(endpointId(link.target));
      ends[e] = s === undefined || t === undefined ? null : [s, t];
    }
    entry.incidence = buildIncidence(ends, index.size);
  }
  return entry.incidence;
}

/** One edge's interned endpoints, or null when either end is not a node here. */
type Ends = [number, number] | null;

/**
 * The shared fill. Counts each node's entries, lays out the offsets, then
 * walks the edges once more appending to both endpoints, which is what puts a
 * node's entries in edge order.
 */
function buildIncidence(ends: Ends[], n: number): Incidence {
  const offsets = new Int32Array(n + 1);
  for (const pair of ends) {
    if (pair === null) continue;
    offsets[pair[0] + 1]++;
    offsets[pair[1] + 1]++;
  }
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];

  const total = offsets[n];
  const neighbor = new Int32Array(total);
  const link = new Int32Array(total);
  const forward = new Uint8Array(total);
  const at = offsets.slice(0, n);
  for (let e = 0; e < ends.length; e++) {
    const pair = ends[e];
    if (pair === null) continue;
    const [s, t] = pair;
    let p = at[s]++;
    neighbor[p] = t;
    link[p] = e;
    forward[p] = 1;
    p = at[t]++;
    neighbor[p] = s;
    link[p] = e;
    forward[p] = 0;
  }
  return { offsets, neighbor, link, forward };
}

/**
 * The document's own incidence, over `doc.edges.rows` rather than a built
 * graph's merged links, so `link[p]` is a row index.
 *
 * Endpoints the node table has never heard of are interned after the declared
 * nodes rather than dropped: the same reason `buildBaseGraph` renders them,
 * which is that reconciliation is a separate step and the rows are already
 * there.
 */
export interface DocIncidence extends Incidence, Interner {}

interface DocEntry {
  /** What it was built from, since none of these can be watched by identity alone. */
  edgeRows: Row[];
  source: string;
  target: string;
  idColumn: string;
  value: DocIncidence;
}

const docs = new WeakMap<Row[], DocEntry>();

export function docIncidence(doc: GraphDoc): DocIncidence {
  const cached = docs.get(doc.nodes.rows);
  if (
    cached !== undefined &&
    cached.edgeRows === doc.edges.rows &&
    cached.source === doc.mapping.source &&
    cached.target === doc.mapping.target &&
    cached.idColumn === doc.nodeIdColumn
  ) {
    return cached.value;
  }

  const ids: string[] = [];
  const index = new Map<string, number>();
  const intern = (id: string): number => {
    let at = index.get(id);
    if (at === undefined) {
      at = ids.length;
      ids.push(id);
      index.set(id, at);
    }
    return at;
  };
  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id !== null) intern(id);
  }

  const rows = doc.edges.rows;
  const { source, target } = doc.mapping;
  // Endpoints are interned as they are read, so the ids are complete before
  // the offsets are sized.
  const ends: Ends[] = new Array(rows.length);
  for (let e = 0; e < rows.length; e++) {
    const s = cellToId(rows[e][source]);
    const t = cellToId(rows[e][target]);
    ends[e] = s === null || t === null ? null : [intern(s), intern(t)];
  }

  const value: DocIncidence = { ids, index, ...buildIncidence(ends, ids.length) };
  docs.set(doc.nodes.rows, {
    edgeRows: doc.edges.rows,
    source,
    target,
    idColumn: doc.nodeIdColumn,
    value,
  });
  return value;
}
