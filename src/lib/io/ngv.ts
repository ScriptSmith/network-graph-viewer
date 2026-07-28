import type { Graph, GraphDoc, GraphStyle } from "../../types";
import { DEFAULT_STYLE } from "../../types";
import type { FilterStep } from "../filter";
import type { LayoutId, LayoutParams } from "../layouts";
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

export function writeWorkspace(input: WorkspaceInput): string {
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
  return JSON.stringify(workspace, null, 2);
}

export function looksLikeWorkspace(text: string): boolean {
  return text.includes('"network-graph-viewer"');
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

  const doc: GraphDoc = { ...workspace.doc, name: workspace.doc.name || name };
  const positions = new Map<string, Position>(Object.entries(workspace.positions ?? {}));
  return {
    doc,
    positions: positions.size > 0 ? positions : undefined,
    workspace: {
      format: "network-graph-viewer",
      version: workspace.version ?? NGV_VERSION,
      doc,
      style: { ...DEFAULT_STYLE, ...workspace.style },
      chain: workspace.chain ?? [],
      layout: workspace.layout ?? "force",
      layoutParams: workspace.layoutParams ?? {},
      showIsolated: workspace.showIsolated ?? doc.nodesDeclared,
      preventOverlap: workspace.preventOverlap ?? false,
      positions: workspace.positions ?? {},
      scripts: workspace.scripts,
    },
  };
}
