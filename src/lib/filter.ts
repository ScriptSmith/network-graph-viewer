import type { BaseGraph, ColumnFilter, GraphDoc, Row, Table } from "../types";
import { cellKey, cellToId, edgeKey } from "./cells";
import { buildBaseGraph, distinctValues, endpointId } from "./graph";
import { asNumber } from "./parse";
import { toMetricGraph } from "./metrics";
import { disparity } from "./metrics/edges";
import { undirected } from "./metrics/model";
import { components, coreness } from "./metrics/structure";

/**
 * Filters form an ordered chain rather than a set of independent conditions.
 * Each step receives the subgraph the previous one produced, so "degree at
 * least 2" placed after "two steps out from Alex" means degree *within that
 * neighbourhood*. Reordering the same two steps is a different question, and
 * gets a different answer, which is the whole point.
 */

export type FilterSpec =
  | { kind: "column"; table: "nodes" | "edges"; column: string; op: ColumnFilter }
  | { kind: "degree"; mode: "all" | "in" | "out"; min: number | null; max: number | null }
  | { kind: "kcore"; k: number }
  | { kind: "component"; count: number }
  | { kind: "ego"; centers: string[]; depth: number; direction: "any" | "out" | "in" }
  | { kind: "mutual" }
  | { kind: "backbone"; alpha: number; weightColumn: string | null };

export type FilterStep = { id: string; enabled: boolean } & FilterSpec;

export interface ChainStepResult {
  id: string;
  nodes: number;
  links: number;
}

export interface ChainResult {
  graph: BaseGraph;
  /** Node and link counts remaining after each step, in chain order. */
  steps: ChainStepResult[];
}

let stepCounter = 0;

/** Ids only need to be unique within a session, and must not depend on a clock. */
export function newStepId(): string {
  return `step-${++stepCounter}`;
}

export function describeStep(step: FilterStep): string {
  switch (step.kind) {
    case "column":
      return step.column;
    case "degree": {
      const label = step.mode === "all" ? "Degree" : `${step.mode === "in" ? "In" : "Out"}-degree`;
      return label;
    }
    case "kcore":
      return `${step.k}-core`;
    case "component":
      return step.count === 1 ? "Giant component" : `${step.count} largest components`;
    case "ego":
      return step.centers.length === 1
        ? `${step.depth} step${step.depth === 1 ? "" : "s"} from ${step.centers[0]}`
        : `${step.depth} steps from ${step.centers.length} nodes`;
    case "mutual":
      return "Reciprocated edges";
    case "backbone":
      return `Backbone (α ≤ ${step.alpha})`;
  }
}

export const FILTER_KINDS: { kind: FilterSpec["kind"]; name: string; blurb: string }[] = [
  { kind: "column", name: "Column value", blurb: "Match a column on the edges or the nodes." },
  { kind: "degree", name: "Degree range", blurb: "Keep nodes by how many connections they have." },
  { kind: "kcore", name: "k-core", blurb: "Peel away everything below a density threshold." },
  {
    kind: "component",
    name: "Largest components",
    blurb: "Keep the biggest islands, drop the rest.",
  },
  { kind: "ego", name: "Ego network", blurb: "Everything within N steps of chosen nodes." },
  { kind: "mutual", name: "Reciprocated only", blurb: "Keep edges whose reverse also exists." },
  {
    kind: "backbone",
    name: "Disparity backbone",
    blurb: "Keep only statistically significant edges.",
  },
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === "number";

function isColumnFilter(value: unknown): value is ColumnFilter {
  if (!isRecord(value)) return false;
  if (value.kind === "values") {
    return Array.isArray(value.selected) && value.selected.every((s) => typeof s === "string");
  }
  return value.kind === "range" && isNumberOrNull(value.min) && isNumberOrNull(value.max);
}

/**
 * Whether a value is a step `applyStep` can actually run. A chain arrives inside
 * a workspace, which arrives from a link anyone wrote, and every branch below
 * reads fields the switch would otherwise dereference off `undefined`.
 */
export function isFilterStep(value: unknown): value is FilterStep {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.enabled !== "boolean") return false;
  switch (value.kind) {
    case "column":
      return (
        (value.table === "nodes" || value.table === "edges") &&
        typeof value.column === "string" &&
        isColumnFilter(value.op)
      );
    case "degree":
      return (
        (value.mode === "all" || value.mode === "in" || value.mode === "out") &&
        isNumberOrNull(value.min) &&
        isNumberOrNull(value.max)
      );
    case "kcore":
      return typeof value.k === "number";
    case "component":
      return typeof value.count === "number";
    case "ego":
      return (
        Array.isArray(value.centers) &&
        value.centers.every((c) => typeof c === "string") &&
        typeof value.depth === "number" &&
        (value.direction === "any" || value.direction === "out" || value.direction === "in")
      );
    case "mutual":
      return true;
    case "backbone":
      return (
        typeof value.alpha === "number" &&
        (value.weightColumn === null || typeof value.weightColumn === "string")
      );
    default:
      return false;
  }
}

/**
 * The step a single click adds: one column pinned to one value. A legend entry
 * and a breakdown bar both add exactly this, so both can find their own step
 * here to show it as active and to take it back off the chain.
 */
export function findValueStep(
  chain: FilterStep[],
  table: "nodes" | "edges",
  column: string,
  value: string,
): FilterStep | undefined {
  return chain.find(
    (step) =>
      step.kind === "column" &&
      step.table === table &&
      step.column === column &&
      step.op.kind === "values" &&
      step.op.selected.length === 1 &&
      step.op.selected[0] === value,
  );
}

/**
 * The step a column header binds to: the first column step naming that column
 * on that table. A header filter and a sidebar step are the same object, so
 * setting one from either end has to find what the other already put there.
 */
export function findColumnStep(
  chain: FilterStep[],
  table: "nodes" | "edges",
  column: string,
): FilterStep | undefined {
  return chain.find(
    (step) => step.kind === "column" && step.table === table && step.column === column,
  );
}

/**
 * Point the chain at a column that has just been renamed, or take off the steps
 * that named one just deleted. A step holds its column by name and says which
 * table it belongs to, so this is exact rather than a guess.
 */
export function retargetChain(
  chain: FilterStep[],
  table: "nodes" | "edges",
  from: string,
  to: string | null,
): FilterStep[] {
  const out: FilterStep[] = [];
  for (const step of chain) {
    if (step.kind === "column" && step.table === table && step.column === from) {
      // A condition names the values of the column it was built against, so it
      // survives a rename of the column itself unchanged.
      if (to !== null) out.push({ ...step, column: to });
      continue;
    }
    if (step.kind === "backbone" && table === "edges" && step.weightColumn === from) {
      out.push({ ...step, weightColumn: to });
      continue;
    }
    out.push(step);
  }
  return out;
}

/** A condition that lets everything through, so a fresh step is a no-op. */
export function neutralCondition(table: Table, columnName: string): ColumnFilter {
  const column = table.columns.find((c) => c.name === columnName);
  if (column?.type === "number") return { kind: "range", min: null, max: null };
  return { kind: "values", selected: distinctValues(table.rows, columnName).map((v) => v.key) };
}

export function defaultStep(kind: FilterSpec["kind"], doc: GraphDoc): FilterStep {
  const id = newStepId();
  switch (kind) {
    case "column": {
      // A new step starts as a no-op, so adding one never blanks the canvas.
      const column = doc.edges.columns[0]?.name ?? "";
      return {
        id,
        enabled: true,
        kind: "column",
        table: "edges",
        column,
        op: neutralCondition(doc.edges, column),
      };
    }
    case "degree":
      return { id, enabled: true, kind: "degree", mode: "all", min: 1, max: null };
    case "kcore":
      return { id, enabled: true, kind: "kcore", k: 2 };
    case "component":
      return { id, enabled: true, kind: "component", count: 1 };
    case "ego":
      return { id, enabled: true, kind: "ego", centers: [], depth: 1, direction: "any" };
    case "mutual":
      return { id, enabled: true, kind: "mutual" };
    case "backbone":
      return { id, enabled: true, kind: "backbone", alpha: 0.3, weightColumn: null };
  }
}

/** What one step narrows the working set to. */
interface Narrowing {
  rows: Row[];
  keepNodes: ReadonlySet<string> | null;
}

export interface ChainOptions {
  showIsolated: boolean;
}

export function applyChain(doc: GraphDoc, chain: FilterStep[], options: ChainOptions): ChainResult {
  let rows: Row[] = doc.edges.rows;
  let keepNodes: ReadonlySet<string> | null = null;
  const build = () =>
    buildBaseGraph(doc, { edgeRows: rows, showIsolated: options.showIsolated, keepNodes });

  let graph = build();
  const steps: ChainStepResult[] = [];

  for (const step of chain) {
    if (step.enabled) {
      const narrowed = applyStep(step, graph, doc, rows, keepNodes);
      rows = narrowed.rows;
      keepNodes = narrowed.keepNodes;
      graph = build();
    }
    steps.push({ id: step.id, nodes: graph.nodes.length, links: graph.links.length });
  }

  return { graph, steps };
}

function applyStep(
  step: FilterStep,
  graph: BaseGraph,
  doc: GraphDoc,
  rows: Row[],
  keepNodes: ReadonlySet<string> | null,
): Narrowing {
  switch (step.kind) {
    case "column": {
      const test = compileCondition(step.op);
      return step.table === "edges"
        ? { rows: rows.filter((row) => test(row, step.column)), keepNodes }
        : {
            rows,
            keepNodes: intersect(
              keepNodes,
              nodeIdsWhere(doc, (row) => test(row, step.column)),
            ),
          };
    }

    case "degree": {
      const keep = new Set<string>();
      for (const node of graph.nodes) {
        const value = valueFor(node.inDegree, node.outDegree, node.degree, step.mode);
        if (step.min !== null && value < step.min) continue;
        if (step.max !== null && value > step.max) continue;
        keep.add(node.id);
      }
      return { rows, keepNodes: intersect(keepNodes, keep) };
    }

    case "kcore": {
      const metric = toMetricGraph(graph);
      const cores = coreness(undirected(metric));
      const keep = new Set<string>();
      metric.ids.forEach((id, i) => {
        if (cores[i] >= step.k) keep.add(id);
      });
      return { rows, keepNodes: intersect(keepNodes, keep) };
    }

    case "component": {
      const metric = toMetricGraph(graph);
      const { ids } = components(undirected(metric));
      const keep = new Set<string>();
      metric.ids.forEach((id, i) => {
        if (ids[i] < step.count) keep.add(id);
      });
      return { rows, keepNodes: intersect(keepNodes, keep) };
    }

    case "ego":
      return { rows, keepNodes: intersect(keepNodes, reachable(graph, step)) };

    case "mutual": {
      const present = new Set(
        graph.links.map((l) => edgeKey(endpointId(l.source), endpointId(l.target))),
      );
      return {
        rows: rows.filter((row) => {
          const source = cellToId(row[doc.mapping.source]);
          const target = cellToId(row[doc.mapping.target]);
          return source !== null && target !== null && present.has(edgeKey(target, source));
        }),
        keepNodes,
      };
    }

    case "backbone": {
      const metric = toMetricGraph(graph, step.weightColumn);
      const alpha = disparity(metric);
      const keep = new Set<string>();
      for (let e = 0; e < metric.source.length; e++) {
        if (alpha[e] <= step.alpha) {
          keep.add(edgeKey(metric.ids[metric.source[e]], metric.ids[metric.target[e]]));
        }
      }
      return {
        rows: rows.filter((row) => {
          const source = cellToId(row[doc.mapping.source]);
          const target = cellToId(row[doc.mapping.target]);
          return source !== null && target !== null && keep.has(edgeKey(source, target));
        }),
        keepNodes,
      };
    }
  }
}

function valueFor(
  inDegree: number,
  outDegree: number,
  degree: number,
  mode: "all" | "in" | "out",
): number {
  if (mode === "in") return inDegree;
  if (mode === "out") return outDegree;
  return degree;
}

/** Nodes within `depth` hops of the chosen centres, following the chosen direction. */
function reachable(
  graph: BaseGraph,
  step: Extract<FilterSpec, { kind: "ego" }>,
): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>();
  const push = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const link of graph.links) {
    const s = endpointId(link.source);
    const t = endpointId(link.target);
    if (step.direction !== "in") push(s, t);
    if (step.direction !== "out") push(t, s);
  }

  const present = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set<string>();
  let frontier: string[] = [];
  for (const centre of step.centers) {
    if (present.has(centre) && !seen.has(centre)) {
      seen.add(centre);
      frontier.push(centre);
    }
  }

  for (let hop = 0; hop < step.depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacency.get(id) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

function nodeIdsWhere(doc: GraphDoc, predicate: (row: Row) => boolean): Set<string> {
  const keep = new Set<string>();
  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id !== null && predicate(row)) keep.add(id);
  }
  return keep;
}

function intersect(
  current: ReadonlySet<string> | null,
  next: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!current) return next;
  const out = new Set<string>();
  for (const id of next) {
    if (current.has(id)) out.add(id);
  }
  return out;
}

/**
 * Whether a condition actually takes anything out. A values condition with
 * every value ticked and a range with neither end set both let the whole table
 * through, so a control showing itself as "on" for either would be lying.
 */
export function narrows(rows: Row[], column: string, filter: ColumnFilter): boolean {
  if (filter.kind === "range") return filter.min !== null || filter.max !== null;
  const selected = new Set(filter.selected);
  return distinctValues(rows, column).some((v) => !selected.has(v.key));
}

/**
 * Compile a condition into a test over one row.
 *
 * The compile step is the point. A values condition holds a list, and a fresh
 * step is seeded with *every* distinct value so that adding one never blanks
 * the canvas, which means the list is as long as the column's cardinality.
 * Searching it per row makes a filter that changes nothing cost rows x values,
 * and this runs inside a render on every keystroke of a cell edit. Built once
 * per step, the same work is a hash lookup.
 */
export function compileCondition(filter: ColumnFilter): (row: Row, column: string) => boolean {
  if (filter.kind === "values") {
    const selected = new Set(filter.selected);
    return (row, column) => selected.has(cellKey(row[column]));
  }
  const { min, max } = filter;
  return (row, column) => {
    const v = asNumber(row[column]);
    if (v === null) return false;
    if (min !== null && v < min) return false;
    if (max !== null && v > max) return false;
    return true;
  };
}

/**
 * Whether one row satisfies a column condition. For a single row; anything
 * walking a table should compile the condition once with `compileCondition`.
 */
export function passes(row: Row, column: string, filter: ColumnFilter): boolean {
  return compileCondition(filter)(row, column);
}
