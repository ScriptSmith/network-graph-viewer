import type { BaseGraph, ColumnFilter, GraphDoc, Row, Table } from "../types";
import { cellKey, cellToId, edgeKey } from "./cells";
import { buildBaseGraph, endpointId } from "./graph";
import { incidenceOf, nodeIndex } from "./graphIndex";
import { distinctsOf } from "./stats";
import { asNumber, asTime } from "./parse";
import { timeColumns } from "./timeline";
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
  | {
      kind: "ego";
      centers: string[];
      /** 0 is the centres alone, which is a way of asking "just these". */
      depth: number;
      direction: "any" | "out" | "in";
      /**
       * Only edges whose column matches are walked. The reach is still
       * measured on the narrowed graph, so this is "so many stops along
       * these lines" rather than a filter applied afterwards.
       *
       * Two forms, the same pair a column condition has and for the same
       * reason: `values` is the whitelist every constraint written before
       * meant, and `excluded` lets the panel's line toggles subtract one kind
       * without first naming every other.
       */
      where?: EgoWhere;
      /**
       * Keep only the rows actually walked: those carrying a step from one
       * depth to the next. Off by default, because the neighbourhood has
       * always included every edge between the nodes it reached, and a saved
       * workspace must keep meaning what it meant.
       *
       * On, the answer is the walk rather than the region: with a constraint
       * the edges of other kinds between reached nodes go, and without one a
       * depth-1 walk is a star rather than the neighbourhood with its own
       * cross-links drawn in. An edge between two centres is not a step from
       * one depth to the next, so it is not walked either.
       */
      walkedOnly?: boolean;
    }
  | { kind: "mutual" }
  | { kind: "backbone"; alpha: number; weightColumn: string | null }
  /**
   * A window over a time column, bounds inclusive, read through `asTime` so
   * dates and plain numbers both work. An ordinary step: it sits in the
   * chain, order matters, and the timeline strip is just an editor for it.
   */
  | {
      kind: "timewindow";
      table: "nodes" | "edges";
      column: string;
      min: number | null;
      max: number | null;
    };

/**
 * `invert` keeps what the step would drop: the complement, taken within the
 * subgraph entering the step, so an inverted ego step is everything outside
 * the neighbourhood and an inverted component step is the small islands.
 */
export type FilterStep = { id: string; enabled: boolean; invert?: boolean } & FilterSpec;

/** Which edges an ego walk is allowed to follow. */
export type EgoWhere =
  | { column: string; values: string[] }
  | { column: string; excluded: string[] };

/**
 * Compile a walk constraint into a test over one cell key. Absent, everything
 * is walkable and the test is not run at all.
 */
export function compileWhere(where: EgoWhere | undefined): ((key: string) => boolean) | null {
  if (where === undefined) return null;
  if ("excluded" in where) {
    if (where.excluded.length === 0) return null;
    const excluded = new Set(where.excluded);
    return (key) => !excluded.has(key);
  }
  const selected = new Set(where.values);
  return (key) => selected.has(key);
}

/** Whether a walk constraint lets a named kind through, for the editors. */
export function whereWalks(where: EgoWhere | undefined, kind: string): boolean {
  const test = compileWhere(where);
  return test === null || test(kind);
}

/**
 * A pasted list of ids, in the two shapes lists arrive in. Lines, commas and
 * semicolons are the separators when the text has any, and only then does
 * whitespace count: an id is very often a name with a space in it, and
 * splitting "Mill Quay, Quayside" on spaces would ask for three nodes that do
 * not exist instead of the two that do. Not a list at all (fewer than two
 * parts) answers null, so a paste of one name falls through to typing.
 */
export function splitSeedList(text: string): string[] | null {
  const separated = /[\n,;]/.test(text);
  const parts = text
    .split(separated ? /[\n,;]+/ : /\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length < 2 ? null : parts;
}

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

/**
 * What a step says it does, in the chain and in the undo history.
 *
 * `label` resolves a node id to its display name, so an ego step reads as the
 * name on the canvas rather than the key underneath it. Optional, because the
 * id is a perfectly good answer where no label column is chosen and because
 * plenty of callers have no document to hand.
 */
export function describeStep(step: FilterStep, label?: (id: string) => string): string {
  const name = describeSpec(step, label);
  return step.invert === true ? `not: ${name}` : name;
}

function describeSpec(step: FilterStep, label?: (id: string) => string): string {
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
    case "ego": {
      const from =
        step.centers.length === 1
          ? (label?.(step.centers[0]) ?? step.centers[0])
          : `${step.centers.length} nodes`;
      // Depth 0 is not "0 steps from" anything; it is the centres themselves.
      const reach =
        step.depth === 0
          ? step.centers.length === 1
            ? from
            : `${from} only`
          : `${step.depth} step${step.depth === 1 ? "" : "s"} from ${from}`;
      const walked = step.walkedOnly === true ? ", walked only" : "";
      return step.where === undefined
        ? `${reach}${walked}`
        : `${reach} via ${step.where.column}${walked}`;
    }
    case "mutual":
      return "Reciprocated edges";
    case "backbone":
      return `Backbone (α ≤ ${step.alpha})`;
    case "timewindow":
      return `${step.column} window`;
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
  {
    kind: "timewindow",
    name: "Time window",
    blurb: "Keep rows inside a window over a time or number column.",
  },
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === "number";

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

export function isEgoWhere(value: unknown): value is EgoWhere {
  if (!isRecord(value) || typeof value.column !== "string") return false;
  // Exactly one of the two forms, for the reason a column condition is.
  if (isStringArray(value.values)) return value.excluded === undefined;
  return isStringArray(value.excluded) && value.values === undefined;
}

export function isColumnFilter(value: unknown): value is ColumnFilter {
  if (!isRecord(value)) return false;
  if (value.kind === "values") {
    // Exactly one of the two forms. A record carrying both says two different
    // things about the same column and there is no reading that picks a
    // winner, so it is not a condition this can run.
    if (isStringArray(value.selected)) return value.excluded === undefined;
    return isStringArray(value.excluded) && value.selected === undefined;
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
  if (value.invert !== undefined && typeof value.invert !== "boolean") return false;
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
        (value.direction === "any" || value.direction === "out" || value.direction === "in") &&
        (value.walkedOnly === undefined || typeof value.walkedOnly === "boolean") &&
        (value.where === undefined || isEgoWhere(value.where))
      );
    case "mutual":
      return true;
    case "backbone":
      return (
        typeof value.alpha === "number" &&
        (value.weightColumn === null || typeof value.weightColumn === "string")
      );
    case "timewindow":
      return (
        (value.table === "nodes" || value.table === "edges") &&
        typeof value.column === "string" &&
        isNumberOrNull(value.min) &&
        isNumberOrNull(value.max)
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
      "selected" in step.op &&
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
    if (step.kind === "timewindow" && step.table === table && step.column === from) {
      if (to !== null) out.push({ ...step, column: to });
      continue;
    }
    if (step.kind === "backbone" && table === "edges" && step.weightColumn === from) {
      out.push({ ...step, weightColumn: to });
      continue;
    }
    if (step.kind === "ego" && table === "edges" && step.where?.column === from) {
      // A rename follows; a delete drops only the constraint, since the reach
      // itself never named the column.
      if (to !== null) {
        out.push({ ...step, where: { ...step.where, column: to } });
      } else {
        const { where: _dropped, ...rest } = step;
        out.push(rest);
      }
      continue;
    }
    out.push(step);
  }
  return out;
}

/**
 * A condition that lets everything through, so a fresh step is a no-op.
 *
 * The empty exclusion is what makes that free. Seeding the whitelist form
 * instead meant reading the column's every distinct value into the step, which
 * cost a full scan to open the editor, rode along in every share link, and was
 * re-stringified per render; on a high-cardinality column it made the values
 * filter unusable. Nothing is scanned here now.
 */
export function neutralCondition(table: Table, columnName: string): ColumnFilter {
  const column = table.columns.find((c) => c.name === columnName);
  if (column?.type === "number") return { kind: "range", min: null, max: null };
  return { kind: "values", excluded: [] };
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
    case "timewindow": {
      // Unbounded to start, so adding the step never blanks the canvas, and
      // aimed at a column that actually reads as a time axis when one exists.
      const offered = timeColumns(doc)[0];
      return {
        id,
        enabled: true,
        kind: "timewindow",
        table: offered?.table ?? "edges",
        column:
          offered?.column ??
          doc.edges.columns.find((c) => c.type === "number")?.name ??
          doc.edges.columns[0]?.name ??
          "",
        min: null,
        max: null,
      };
    }
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
      const narrowed = narrow(step, graph, doc, rows, keepNodes);
      rows = narrowed.rows;
      keepNodes = narrowed.keepNodes;
      graph = build();
    }
    steps.push({ id: step.id, nodes: graph.nodes.length, links: graph.links.length });
  }

  return { graph, steps };
}

/**
 * One step's narrowing, inversion included. Inversion is defined here, once,
 * so every kind inverts the same way: the step runs normally, and what comes
 * out is the incoming set minus what it kept. Rows complement against the
 * rows that came in; nodes complement against the nodes of the incoming
 * subgraph, and the node set is then re-derived by the next build under the
 * ordinary `showIsolated` rules.
 */
function narrow(
  step: FilterStep,
  graph: BaseGraph,
  doc: GraphDoc,
  rows: Row[],
  keepNodes: ReadonlySet<string> | null,
): Narrowing {
  // A step that constrains nothing is the common case: every column step is
  // born that way. Answering it here hands both halves back by identity, which
  // costs no copy and leaves the arrays downstream caches key on alone.
  // Inverted, the same step is the empty set rather than a no-op, so the
  // shortcut only holds the one way round.
  if (step.invert !== true && step.kind === "column" && isNeutral(step.op)) {
    return { rows, keepNodes };
  }

  const narrowed = applyStep(step, graph, doc, rows, keepNodes);
  if (step.invert !== true) return narrowed;

  if (narrowedHalf(step) === "rows") {
    const kept = new Set(narrowed.rows);
    return { rows: rows.filter((row) => !kept.has(row)), keepNodes };
  }

  const kept = narrowed.keepNodes;
  const complement = new Set<string>();
  for (const node of graph.nodes) {
    if (kept === null || !kept.has(node.id)) complement.add(node.id);
  }
  return { rows, keepNodes: intersect(keepNodes, complement) };
}

/**
 * Whether a condition lets every row through, answered without touching the
 * data. Only the empty exclusion qualifies: an unbounded range still drops
 * rows whose cell is not a number, and a whitelist cannot be judged without
 * reading the column.
 */
function isNeutral(filter: ColumnFilter): boolean {
  return filter.kind === "values" && "excluded" in filter && filter.excluded.length === 0;
}

/**
 * Which half of the working set a kind of step narrows: the edge rows, or the
 * node set. It is a property of the kind, never of what came back.
 *
 * Inversion has to be told this rather than infer it. Comparing what a step
 * returned against what it was given reads "let everything through" as "did
 * not run", and those inverted are opposite answers: everything, versus the
 * empty set an inverted no-op has always produced. That inference held only
 * while every step copied its half unconditionally, which stopped being true
 * the moment a condition could be a no-op cheaply enough to return its input
 * untouched.
 */
function narrowedHalf(step: FilterStep): "rows" | "nodes" {
  switch (step.kind) {
    case "column":
    case "timewindow":
      return step.table === "edges" ? "rows" : "nodes";
    case "mutual":
    case "backbone":
      return "rows";
    case "degree":
    case "kcore":
    case "component":
    case "ego":
      return "nodes";
  }
}

/**
 * What one step receives: the chain run up to but not including it. A step's
 * editor should describe what the step will actually see, which stops being
 * the whole document the moment anything sits above it in the chain. Run when
 * an editor needs it, never inside `applyChain`'s render path.
 */
export function chainInputBefore(
  doc: GraphDoc,
  chain: FilterStep[],
  stepId: string,
  options: ChainOptions,
): { graph: BaseGraph; rows: Row[] } {
  let rows: Row[] = doc.edges.rows;
  let keepNodes: ReadonlySet<string> | null = null;
  const build = () =>
    buildBaseGraph(doc, { edgeRows: rows, showIsolated: options.showIsolated, keepNodes });

  let graph = build();
  for (const step of chain) {
    if (step.id === stepId) break;
    if (!step.enabled) continue;
    const narrowed = narrow(step, graph, doc, rows, keepNodes);
    rows = narrowed.rows;
    keepNodes = narrowed.keepNodes;
    graph = build();
  }
  return { graph, rows };
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

    case "ego": {
      const reach = reachable(graph, step);
      const keep = intersect(keepNodes, reach.nodes);
      // Inverted, the step is everything *outside* the neighbourhood, where
      // nothing was walked and "only the walked rows" has no reading. So the
      // narrowed half stays the node set either way, which is what lets
      // `narrowedHalf` keep answering with one of them.
      if (reach.walked === null || step.invert === true) return { rows, keepNodes: keep };
      // The walk collected the rows it stepped along, and those are a subset
      // of the ones that built this graph, so membership is all this asks.
      const kept = reach.walked;
      return { rows: rows.filter((row) => kept.has(row)), keepNodes: keep };
    }

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

    case "timewindow": {
      const { min, max } = step;
      const inside = (row: Row): boolean => {
        const t = asTime(row[step.column]);
        if (t === null) return false;
        if (min !== null && t < min) return false;
        if (max !== null && t > max) return false;
        return true;
      };
      return step.table === "edges"
        ? { rows: rows.filter(inside), keepNodes }
        : { rows, keepNodes: intersect(keepNodes, nodeIdsWhere(doc, inside)) };
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

/** What one ego walk found: the nodes it reached, and the rows it stepped along. */
interface Reach {
  nodes: ReadonlySet<string>;
  /**
   * The rows carrying a step from one depth to the next, or null when unasked.
   *
   * Rows rather than links, because a link is a merge of every row with the
   * same endpoints and the walk did not take all of them: where a pair is
   * joined by both a rail row and a bus row, a rail-constrained walk stepped
   * along one of them.
   */
  walked: ReadonlySet<Row> | null;
}

/** Nodes within `depth` hops of the chosen centres, following the chosen direction. */
function reachable(graph: BaseGraph, step: Extract<FilterSpec, { kind: "ego" }>): Reach {
  const { index, ids } = nodeIndex(graph);
  const { offsets, neighbor, link, forward } = incidenceOf(graph);

  // The constraint compiles to one test before the walk: a link merges every
  // row with the same endpoints, and any one of them matching opens the edge.
  // Only the links actually reached are tested, rather than all of them.
  const where = step.where;
  const test = compileWhere(where);
  const column = where?.column;
  const walkableRow = (row: Row): boolean =>
    test === null || column === undefined || test(cellKey(row[column]));
  const walkable = (e: number): boolean =>
    test === null || column === undefined || graph.links[e].rows.some(walkableRow);

  // -1 is unreached; anything else is how many steps out it was found.
  const depth = new Int32Array(ids.length).fill(-1);
  const nodes = new Set<string>();
  const walked = step.walkedOnly === true ? new Set<Row>() : null;
  let frontier: number[] = [];
  for (const centre of step.centers) {
    const at = index.get(centre);
    if (at !== undefined && depth[at] === -1) {
      depth[at] = 0;
      nodes.add(centre);
      frontier.push(at);
    }
  }

  for (let hop = 0; hop < step.depth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const v of frontier) {
      for (let p = offsets[v]; p < offsets[v + 1]; p++) {
        // One undirected structure answers all three directions: an entry is
        // walkable outward when its owner is the link's source.
        if (step.direction === "out" && forward[p] === 0) continue;
        if (step.direction === "in" && forward[p] === 1) continue;
        const other = neighbor[p];
        if (depth[other] !== -1 && depth[other] !== hop + 1) continue;
        if (!walkable(link[p])) continue;
        if (depth[other] === -1) {
          depth[other] = hop + 1;
          nodes.add(ids[other]);
          next.push(other);
        }
        // Every link from this depth to the next counts, not only the one
        // that got there first, or the walk would come out a spanning tree
        // with the routes that tie for shortest missing from it.
        if (walked !== null) {
          for (const row of graph.links[link[p]].rows as Row[]) {
            if (walkableRow(row)) walked.add(row);
          }
        }
      }
    }
    frontier = next;
  }
  return { nodes, walked };
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
  // An exclusion answers for itself. Only the whitelist form has to be read
  // against the column to know whether it leaves anything out.
  if ("excluded" in filter) return filter.excluded.length > 0;
  const selected = new Set(filter.selected);
  return distinctsOf(rows, column).some((v) => !selected.has(v.key));
}

/**
 * Compile a condition into a test over one row.
 *
 * The compile step is the point. A values condition holds a list as long as
 * whatever the reader picked, and searching it per row makes a filter cost
 * rows x values while this runs inside a render on every keystroke of a cell
 * edit. Built once per step, the same work is a hash lookup.
 */
export function compileCondition(filter: ColumnFilter): (row: Row, column: string) => boolean {
  if (filter.kind === "values") {
    if ("excluded" in filter) {
      // The no-constraint case is the one a fresh step is in, so it is worth
      // not hashing a cell per row to answer "yes" every time.
      if (filter.excluded.length === 0) return () => true;
      const excluded = new Set(filter.excluded);
      return (row, column) => !excluded.has(cellKey(row[column]));
    }
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
