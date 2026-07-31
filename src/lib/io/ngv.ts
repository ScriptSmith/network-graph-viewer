import type { Graph, GraphDoc, GraphStyle, Table } from "../../types";
import { DEFAULT_STYLE } from "../../types";
import { isFilterStep, type FilterStep } from "../filter";
import { isLayoutId, type LayoutId, type LayoutParams } from "../layouts";
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
  scripts?: Record<string, string>;
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
  scripts?: Record<string, string>;
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
    scripts: input.scripts,
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
 * Style tokens are strings the app calls `startsWith` on, and spacing is a
 * number it multiplies by, so each one that arrives as something else falls
 * back to its default rather than reaching the canvas.
 */
function validStyle(value: unknown): GraphStyle {
  const raw = isRecord(value) ? value : {};
  const token = (key: keyof GraphStyle & string): string =>
    typeof raw[key] === "string" ? raw[key] : (DEFAULT_STYLE[key] as string);
  return {
    ...DEFAULT_STYLE,
    ...raw,
    nodeColor: token("nodeColor"),
    nodeSize: token("nodeSize"),
    nodeImage: token("nodeImage"),
    edgeWidth: token("edgeWidth"),
    edgeColor: token("edgeColor"),
    arrows: typeof raw.arrows === "boolean" ? raw.arrows : DEFAULT_STYLE.arrows,
    spacing:
      typeof raw.spacing === "number" && isFinite(raw.spacing)
        ? raw.spacing
        : DEFAULT_STYLE.spacing,
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

  const doc: GraphDoc = {
    ...workspace.doc,
    name: workspace.doc.name || name,
    nodesDeclared: workspace.doc.nodesDeclared === true,
  };
  // Steps and layouts the app does not recognise are dropped rather than
  // refused: the graph is still the graph, and a chain is a view of it.
  const chain = Array.isArray(workspace.chain) ? workspace.chain.filter(isFilterStep) : [];
  const positionRecord = validPositions(workspace.positions);
  const positions = new Map<string, Position>(Object.entries(positionRecord));
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
      scripts: isRecord(workspace.scripts)
        ? (workspace.scripts as Record<string, string>)
        : undefined,
    },
  };
}
