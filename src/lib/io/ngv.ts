import type {
  EdgeTypeStyle,
  Graph,
  GraphDoc,
  GraphStyle,
  NodeTypeStyle,
  Table,
  TypeStyles,
} from "../../types";
import { DEFAULT_STYLE, isColumnRole, isStyleCurve, type ColumnFilter } from "../../types";
import { isColumnFilter, isEgoWhere, isFilterStep, type FilterStep } from "../filter";
import { isLayoutId, type LayoutId, type LayoutParams } from "../layouts";
import { DEFAULT_METRIC_OPTIONS, METRIC_IDS, type ComputedRecipe } from "../metrics";
import { overlayFromJson, overlayIsEmpty, overlayToJson, type EditsOverlay } from "../overlay";
import { WORKING_SET_LIMIT } from "../source/limits";
import type { ColumnPredicate, EdgeSelection, SourceRef } from "../source/types";
import type { ImportedGraph, Position } from "./types";

/**
 * The native workspace format. GEXF and GraphML describe a graph; this
 * describes the whole session, so saving to a gist and reopening the link
 * puts back the filters, the styling, the layout and where everything sat.
 */

export const NGV_VERSION = 1;
export const NGV_EXTENSION = ".ngv.json";

export interface Workspace {
  format: "network-graph-viewer";
  version: number;
  doc: GraphDoc;
  style: GraphStyle;
  chain: FilterStep[];
  layout: LayoutId;
  layoutParams: LayoutParams;
  showIsolated: boolean;
  preventOverlap: boolean;
  /** Node positions, so a saved workspace reopens exactly as it looked. */
  positions: Record<string, Position>;
  /** Nodes held where they were put, layout after layout. */
  pinned?: string[];
  scripts?: Record<string, string>;
  /**
   * The compute runs the user made, as instructions: "update data" re-runs
   * them against the new file rather than trusting the snapshotted values.
   */
  computed?: ComputedRecipe[];
  /** The user's table edits, so a future reload can lay them back on top. */
  edits?: ReturnType<typeof overlayToJson>;
  /**
   * Where the working set was carved from, when it came out of a source too
   * large to embed: which file, and the recipe that selected it.
   *
   * The rows themselves still travel, exactly as they do for any other
   * workspace, so a source-backed link opens into the same graph for anyone.
   * This is what lets the reader who has the file go back for more of it.
   * Never a credential and never a token: a workspace arrives from a link
   * anyone can write, and it goes out in one too.
   */
  source?: SavedSource;
}

/** A source named again: how to find it, and what was taken out of it. */
export interface SavedSource {
  ref: SourceRef;
  selection: EdgeSelection;
}

export interface WorkspaceInput {
  doc: GraphDoc;
  graph: Graph | null;
  style: GraphStyle;
  chain: FilterStep[];
  layout: LayoutId;
  layoutParams: LayoutParams;
  showIsolated: boolean;
  preventOverlap: boolean;
  pinned?: string[];
  scripts?: Record<string, string>;
  computed?: ComputedRecipe[];
  edits?: EditsOverlay;
  source?: SavedSource;
}

export interface WriteWorkspaceOptions {
  /** Off for links, where every byte is one the address bar has to carry. */
  pretty?: boolean;
}

export function writeWorkspace(input: WorkspaceInput, options: WriteWorkspaceOptions = {}): string {
  const positions: Record<string, Position> = {};
  for (const node of input.graph?.nodes ?? []) {
    if (node.x !== undefined && node.y !== undefined) {
      positions[node.id] = { x: Math.round(node.x * 100) / 100, y: Math.round(node.y * 100) / 100 };
    }
  }
  const workspace: Workspace = {
    format: "network-graph-viewer",
    version: NGV_VERSION,
    doc: input.doc,
    style: input.style,
    chain: input.chain,
    layout: input.layout,
    layoutParams: input.layoutParams,
    showIsolated: input.showIsolated,
    preventOverlap: input.preventOverlap,
    positions,
    ...(input.pinned && input.pinned.length > 0 ? { pinned: input.pinned } : {}),
    scripts: input.scripts,
    ...(input.computed && input.computed.length > 0 ? { computed: input.computed } : {}),
    ...(input.edits && !overlayIsEmpty(input.edits) ? { edits: overlayToJson(input.edits) } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
  return JSON.stringify(workspace, null, options.pretty === false ? undefined : 2);
}

export function looksLikeWorkspace(text: string): boolean {
  return text.includes('"network-graph-viewer"');
}

/**
 * Everything below reads a workspace as untrusted.
 *
 * A `.ngv.json` can be a dropped file, but it can equally be the payload of a
 * `#data=` link or a public gist, which is to say a stranger's JSON with our
 * name on it. The document then goes straight onto the render path, where a
 * missing table is not a wrong graph but an exception thrown out of `useMemo`,
 * which unmounts the app. So the shape is checked once, here, and what cannot
 * be repaired is refused with a sentence saying what was wrong.
 *
 * Values are not checked, only shapes: a cell may be anything a cell may be,
 * and 200,000 of them are not worth walking twice.
 */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function isTable(value: unknown): value is Table {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return false;
  if (!value.columns.every((c) => isRecord(c) && typeof c.name === "string")) return false;
  // A null row is the one cell shape that throws rather than reading empty.
  return value.rows.every(isRecord);
}

/** Roles come off an enum; anything else written in their place is dropped. */
function cleanRoles(table: Table): Table {
  if (table.columns.every((c) => c.role === undefined || isColumnRole(c.role))) return table;
  return {
    ...table,
    columns: table.columns.map((c) => {
      if (c.role === undefined || isColumnRole(c.role)) return c;
      const { role: _dropped, ...rest } = c;
      return rest;
    }),
  };
}

function validDoc(value: unknown): value is GraphDoc {
  if (!isRecord(value)) return false;
  const mapping = value.mapping;
  return (
    isTable(value.edges) &&
    isTable(value.nodes) &&
    typeof value.nodeIdColumn === "string" &&
    isRecord(mapping) &&
    typeof mapping.source === "string" &&
    typeof mapping.target === "string" &&
    Array.isArray(mapping.attrs) &&
    mapping.attrs.every((a) => typeof a === "string")
  );
}

/**
 * Type overrides arrive keyed by cell values anyone chose, so the records are
 * rebuilt null-prototyped, colors are held to #rrggbb the way the palette's
 * custom colors are, and anything shaped wrong is dropped rather than worn.
 * Image sources are strings here and vetted by `imageSource` at apply time.
 * A block with a column and no overrides is kept: the chosen column is the
 * section's own state, and losing it on a round trip would be losing work.
 */
const isHexColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

const validAttrs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : undefined;

function validNodeTypeStyles(value: unknown): TypeStyles<NodeTypeStyle> | undefined {
  if (!isRecord(value) || typeof value.column !== "string" || !isRecord(value.styles)) {
    return undefined;
  }
  const styles = Object.create(null) as Record<string, NodeTypeStyle>;
  for (const [key, raw] of Object.entries(value.styles)) {
    if (!isRecord(raw)) continue;
    const out: NodeTypeStyle = {};
    if (isHexColor(raw.color)) out.color = raw.color;
    if (typeof raw.size === "number" && isFinite(raw.size)) out.size = raw.size;
    if (typeof raw.image === "string") out.image = raw.image;
    if (typeof raw.labelColumn === "string") out.labelColumn = raw.labelColumn;
    const attrs = validAttrs(raw.attrs);
    if (attrs !== undefined) out.attrs = attrs;
    if (Object.keys(out).length > 0) styles[key] = out;
  }
  return { column: value.column, styles };
}

function validEdgeTypeStyles(value: unknown): TypeStyles<EdgeTypeStyle> | undefined {
  if (!isRecord(value) || typeof value.column !== "string" || !isRecord(value.styles)) {
    return undefined;
  }
  const styles = Object.create(null) as Record<string, EdgeTypeStyle>;
  for (const [key, raw] of Object.entries(value.styles)) {
    if (!isRecord(raw)) continue;
    const out: EdgeTypeStyle = {};
    if (isHexColor(raw.color)) out.color = raw.color;
    if (typeof raw.width === "number" && isFinite(raw.width)) out.width = raw.width;
    const attrs = validAttrs(raw.attrs);
    if (attrs !== undefined) out.attrs = attrs;
    if (Object.keys(out).length > 0) styles[key] = out;
  }
  return { column: value.column, styles };
}

/**
 * Style tokens are strings the app calls `startsWith` on, and spacing is a
 * number it multiplies by, so each one that arrives as something else falls
 * back to its default rather than reaching the canvas.
 */
function validStyle(value: unknown): GraphStyle {
  const raw = isRecord(value) ? value : {};
  const token = (key: keyof GraphStyle & string): string =>
    typeof raw[key] === "string" ? raw[key] : (DEFAULT_STYLE[key] as string);
  // The curves come off an enum; anything else written in their place is
  // dropped so the channel falls back to its unset behaviour.
  const {
    nodeSizeCurve: rawSizeCurve,
    nodeColorCurve: rawColorCurve,
    edgeWidthCurve: rawWidthCurve,
    ...rest
  } = raw;
  return {
    ...DEFAULT_STYLE,
    ...rest,
    ...(isStyleCurve(rawSizeCurve) ? { nodeSizeCurve: rawSizeCurve } : {}),
    ...(isStyleCurve(rawColorCurve) ? { nodeColorCurve: rawColorCurve } : {}),
    ...(isStyleCurve(rawWidthCurve) ? { edgeWidthCurve: rawWidthCurve } : {}),
    nodeColor: token("nodeColor"),
    nodeSize: token("nodeSize"),
    nodeImage: token("nodeImage"),
    nodeLabel: token("nodeLabel"),
    edgeWidth: token("edgeWidth"),
    edgeColor: token("edgeColor"),
    arrows: typeof raw.arrows === "boolean" ? raw.arrows : DEFAULT_STYLE.arrows,
    spacing:
      typeof raw.spacing === "number" && isFinite(raw.spacing)
        ? raw.spacing
        : DEFAULT_STYLE.spacing,
    typeStyles: validNodeTypeStyles(raw.typeStyles),
    edgeTypeStyles: validEdgeTypeStyles(raw.edgeTypeStyles),
  };
}

/**
 * Compute recipes arrive naming metric ids; unknown ids drop, and an entry
 * with nothing left is not a run. Options are rebuilt field by field.
 */
function validComputed(value: unknown): ComputedRecipe[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ComputedRecipe[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Array.isArray(entry.metrics)) continue;
    const metrics = entry.metrics.filter(
      (m): m is string => typeof m === "string" && METRIC_IDS.includes(m),
    );
    if (metrics.length === 0) continue;
    const raw = isRecord(entry.options) ? entry.options : {};
    out.push({
      metrics,
      options: {
        weightColumn: typeof raw.weightColumn === "string" ? raw.weightColumn : null,
        resolution:
          typeof raw.resolution === "number" && isFinite(raw.resolution)
            ? raw.resolution
            : DEFAULT_METRIC_OPTIONS.resolution,
        ...(raw.louvainStability === true ? { louvainStability: true } : {}),
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * A saved source reference, checked the way every other field is.
 *
 * This arrives from a link anyone can write, and it names a file the reader is
 * about to be asked for. A shape that is not exactly right is dropped rather
 * than repaired: the graph is still the graph, and losing the way back to the
 * source is a smaller harm than acting on a made-up one. Nothing here can
 * cause a fetch by itself.
 */
export function validSource(value: unknown): SavedSource | undefined {
  if (!isRecord(value)) return undefined;
  const { ref, selection } = value;
  if (!isRecord(ref) || !isRecord(selection)) return undefined;

  let checked: SourceRef;
  if (ref.kind === "file") {
    if (typeof ref.name !== "string" || typeof ref.size !== "number") return undefined;
    checked = { kind: "file", name: ref.name, size: ref.size };
  } else if (ref.kind === "url") {
    // http(s) only, and never anything carrying credentials: a workspace must
    // not be able to make the reader's browser sign in as somebody.
    if (typeof ref.url !== "string") return undefined;
    let parsed: URL;
    try {
      parsed = new URL(ref.url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    checked = { kind: "url", url: parsed.toString() };
  } else {
    return undefined;
  }

  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (
    typeof selection.table !== "string" ||
    typeof selection.source !== "string" ||
    typeof selection.target !== "string" ||
    !strings(selection.seeds) ||
    // Finite, not merely a number: `typeof NaN === "number"`, and a NaN depth
    // or budget would reach the engine as `LIMIT NaN`.
    typeof selection.depth !== "number" ||
    !isFinite(selection.depth) ||
    (selection.direction !== "any" &&
      selection.direction !== "out" &&
      selection.direction !== "in") ||
    typeof selection.edgeLimit !== "number" ||
    !isFinite(selection.edgeLimit)
  ) {
    return undefined;
  }

  // The walk constraint and the predicates ride along whole or not at all: a
  // recipe that silently lost its constraint would Reload a different, larger
  // graph than the one that was saved.
  const where = selection.where;
  if (where !== undefined && !isEgoWhere(where)) return undefined;
  let predicates: ColumnPredicate[] | undefined;
  if (selection.predicates !== undefined) {
    if (!Array.isArray(selection.predicates)) return undefined;
    predicates = [];
    for (const entry of selection.predicates) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { column?: unknown }).column !== "string" ||
        !isColumnFilter((entry as { op?: unknown }).op)
      ) {
        return undefined;
      }
      const p = entry as { column: string; op: ColumnFilter };
      predicates.push({ column: p.column, op: p.op });
    }
  }

  return {
    ref: checked,
    selection: {
      table: selection.table,
      source: selection.source,
      target: selection.target,
      seeds: selection.seeds,
      // Clamped rather than trusted: a depth of a million is a walk nobody
      // asked for, and a budget past the ceiling is not the reader's to raise.
      depth: Math.max(0, Math.min(6, Math.round(selection.depth))),
      direction: selection.direction,
      edgeLimit: Math.max(1, Math.min(WORKING_SET_LIMIT, Math.round(selection.edgeLimit))),
      ...(selection.walkedOnly === true ? { walkedOnly: true } : {}),
      ...(where !== undefined ? { where } : {}),
      ...(predicates !== undefined && predicates.length > 0 ? { predicates } : {}),
    },
  };
}

/** Positions that are not two finite numbers would place a node at NaN. */
function validPositions(value: unknown): Record<string, Position> {
  if (!isRecord(value)) return {};
  const out: Record<string, Position> = {};
  for (const [id, point] of Object.entries(value)) {
    if (!isRecord(point)) continue;
    const { x, y } = point;
    if (typeof x === "number" && isFinite(x) && typeof y === "number" && isFinite(y)) {
      out[id] = { x, y };
    }
  }
  return out;
}

export interface ImportedWorkspace extends ImportedGraph {
  workspace: Workspace;
}

export function parseWorkspace(text: string, name: string): ImportedWorkspace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That workspace file is not valid JSON.");
  }
  const workspace = parsed as Partial<Workspace>;
  if (workspace.format !== "network-graph-viewer" || !workspace.doc) {
    throw new Error("That JSON file is not a Network Graph Viewer workspace.");
  }
  if ((workspace.version ?? 0) > NGV_VERSION) {
    throw new Error(
      `That workspace was saved by a newer version (${workspace.version}); this build reads up to ${NGV_VERSION}.`,
    );
  }

  if (!validDoc(workspace.doc)) {
    throw new Error(
      "That workspace is damaged: its edge table, node table or column mapping is missing.",
    );
  }

  // The mapping is rebuilt field by field: `nodeAttrs` is optional and only a
  // string array counts, so junk in its place falls back to the default rather
  // than reaching `.includes` calls, and unknown keys are dropped with it.
  const mapping = workspace.doc.mapping;
  const nodeAttrs = Array.isArray(mapping.nodeAttrs)
    ? mapping.nodeAttrs.filter((a): a is string => typeof a === "string")
    : undefined;
  const doc: GraphDoc = {
    ...workspace.doc,
    name: workspace.doc.name || name,
    nodesDeclared: workspace.doc.nodesDeclared === true,
    edges: cleanRoles(workspace.doc.edges),
    nodes: cleanRoles(workspace.doc.nodes),
    mapping: {
      source: mapping.source,
      target: mapping.target,
      attrs: mapping.attrs,
      ...(nodeAttrs === undefined ? {} : { nodeAttrs }),
    },
  };
  // Steps and layouts the app does not recognise are dropped rather than
  // refused: the graph is still the graph, and a chain is a view of it.
  const chain = Array.isArray(workspace.chain) ? workspace.chain.filter(isFilterStep) : [];
  const positionRecord = validPositions(workspace.positions);
  const positions = new Map<string, Position>(Object.entries(positionRecord));
  const computed = validComputed(workspace.computed);
  const edits = overlayFromJson(workspace.edits);
  const source = validSource(workspace.source);
  return {
    doc,
    positions: positions.size > 0 ? positions : undefined,
    workspace: {
      format: "network-graph-viewer",
      version: workspace.version ?? NGV_VERSION,
      doc,
      style: validStyle(workspace.style),
      chain,
      layout: isLayoutId(workspace.layout) ? workspace.layout : "force",
      layoutParams: isRecord(workspace.layoutParams)
        ? (workspace.layoutParams as LayoutParams)
        : {},
      showIsolated:
        typeof workspace.showIsolated === "boolean" ? workspace.showIsolated : doc.nodesDeclared,
      preventOverlap: workspace.preventOverlap === true,
      positions: positionRecord,
      // Ids that name no node simply never match one; only the shape matters.
      ...(Array.isArray(workspace.pinned)
        ? { pinned: workspace.pinned.filter((p): p is string => typeof p === "string") }
        : {}),
      scripts: isRecord(workspace.scripts)
        ? (workspace.scripts as Record<string, string>)
        : undefined,
      ...(computed !== undefined ? { computed } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(overlayIsEmpty(edits) ? {} : { edits: overlayToJson(edits) }),
    },
  };
}
