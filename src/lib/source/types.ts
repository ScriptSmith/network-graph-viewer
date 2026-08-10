import type { CellValue, Column, ColumnFilter } from "../../types";
import type { EgoWhere } from "../filter";
import type { Bins } from "../histogram";
import type { ImportedGraph } from "../io/types";

/**
 * A source sits **in front of** the document, never underneath it.
 *
 * The app's whole pipeline is built on ordinary in-memory tables, and row
 * object identity is a load-bearing part of it: selections are `Set<Row>`, the
 * overlay diffs rows by reference, and the simulation mutates node objects
 * that point straight into the tables. Nothing here changes any of that. A
 * source answers a small vocabulary of questions about data that may be far
 * larger than memory, and `materialize` produces an ordinary `GraphDoc` which
 * enters the app through the same door a dropped GEXF file does.
 *
 * That is what makes the working set and the source separable questions. The
 * source can be a billion edges; the working set is what a person carved out
 * of it and what the renderer can actually draw.
 *
 * Every method is async and every argument is plain data, so an implementation
 * can live behind a worker, a wasm engine, or a notebook kernel on the other
 * end of a comms channel.
 */
export interface DataSource {
  readonly kind: SourceKind;
  /** Table names, their columns and their exact row counts. Metadata only. */
  schema(): Promise<SourceSchema>;
  distinct(table: string, column: string, limit: number): Promise<DistinctValue[]>;
  range(table: string, column: string): Promise<{ min: number; max: number } | null>;
  bins(table: string, column: string, count: number): Promise<Bins | null>;
  /**
   * How many distinct nodes the endpoint columns name.
   *
   * Allowed to be an estimate, and says which it is: counting exactly means a
   * full pass, and a source card that opens instantly is worth more than a
   * count that is right to the node.
   */
  nodeCount(ends: Endpoints): Promise<NodeCount>;
  /** Nodes whose id contains the query, for the seed picker. */
  searchNodes(ends: Endpoints, query: string, limit: number): Promise<NodeHit[]>;
  /**
   * Which of the named ids the source actually has, deduplicated, in the
   * order they were asked about. Point lookup, so a pasted list of thousands
   * is validated without a search per id.
   */
  lookupIds(ends: Endpoints, ids: string[]): Promise<string[]>;
  /**
   * How searching currently answers, as a free snapshot: `"directory"` when
   * an index makes it a lookup, `"scan"` when every search reads the file,
   * `null` while that has not been settled yet. A UI hint only, optional so
   * a remote implementation need not model it.
   */
  searchMode?(): "directory" | "scan" | null;
  /** What the selection would bring in, counted per hop. No rows are built. */
  neighborhood(selection: EdgeSelection): Promise<NeighborhoodCounts>;
  /** The selection as a document, bounded by its own edge budget. */
  materialize(selection: EdgeSelection): Promise<MaterializeResult>;
  dispose(): void;
}

export type SourceKind = "native" | "duckdb";

export interface SourceTable {
  name: string;
  columns: Column[];
  rowCount: number;
}

export interface SourceSchema {
  tables: SourceTable[];
}

export interface DistinctValue {
  value: CellValue;
  count: number;
}

export interface NodeCount {
  value: number;
  /** True when the number is an estimate rather than a count. */
  approximate: boolean;
}

export interface NodeHit {
  id: string;
  /** A display name when the source has one to offer, else null. */
  label: string | null;
}

/** Where the nodes live: one table, and the two columns naming its endpoints. */
export interface Endpoints {
  table: string;
  source: string;
  target: string;
}

/**
 * A condition pushed down to the source, so rows that cannot survive the
 * filter chain are never read. The same `ColumnFilter` the chain itself uses,
 * so a predicate means exactly what the equivalent step would mean.
 */
export interface ColumnPredicate {
  column: string;
  op: ColumnFilter;
}

/**
 * What to carve out of the source: a neighbourhood, in the same vocabulary the
 * ego filter step speaks, plus the budget it must not exceed.
 *
 * `where` constrains the **walk**, not the result, exactly as it does in the
 * chain: with `walkedOnly` off, edges of other kinds between reached nodes
 * still come back, because they are part of the neighbourhood that was found.
 */
export interface EdgeSelection extends Endpoints {
  /** Empty means take the source from the top rather than from named nodes. */
  seeds: string[];
  /** 0 is the seeds alone. */
  depth: number;
  direction: "any" | "out" | "in";
  where?: EgoWhere;
  walkedOnly?: boolean;
  predicates?: ColumnPredicate[];
  /**
   * The working set's ceiling in edge rows. Every query the engine runs is
   * bounded by this: there is no spilling to disk in a wasm heap, so a
   * selection that would not fit has to be reported rather than attempted.
   */
  edgeLimit: number;
}

export interface HopCount {
  depth: number;
  /** Nodes first reached at this depth. */
  nodes: number;
}

export interface NeighborhoodCounts {
  hops: HopCount[];
  /** Nodes reached in all, seeds included. */
  nodes: number;
  /** Edges among those nodes, which is what materializing would bring back. */
  edges: number;
  /** True when the budget stopped the walk before the graph ran out. */
  truncated: boolean;
}

/**
 * A materialized working set. An `ImportedGraph` with the source's own
 * reporting on top, so it enters the app through the door GEXF and node-link
 * JSON already use rather than through the pick-a-table flow: a source knows
 * which table is the edge list and which nodes go with it, and must not
 * round-trip that through a guess.
 */
export interface MaterializeResult extends ImportedGraph {
  /** Set when the budget clipped the selection, never left to look complete. */
  truncated?: { read: number; total: number };
  hops?: HopCount[];
}

/** A source that was opened from somewhere, for the workspace to name again. */
export type SourceRef = { kind: "file"; name: string; size: number } | { kind: "url"; url: string };

/** Re-exported so a backend can name what it runs without reaching past the module. */
export type { Query, SqlParam } from "./sql";
