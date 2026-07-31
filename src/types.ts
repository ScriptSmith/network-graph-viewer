import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { DEFAULT_PALETTE, DEFAULT_RAMP, type PaletteChoice } from "./theme";

export type CellValue = string | number | boolean | null;
export type Row = Record<string, CellValue>;

export type ColumnType = "text" | "number" | "bool";

/**
 * What a column's values are *for*, on top of what they are. A role never
 * changes the data and never causes a fetch; it tells the UI which affordances
 * fit: a color column can paint the marks, a url column renders as a link, an
 * image column as a thumbnail, a size column as pixels. Inferred cautiously at
 * import, settable from the column menu, and carried by the workspace.
 */
export const COLUMN_ROLES = ["color", "size", "image", "url"] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

export function isColumnRole(value: unknown): value is ColumnRole {
  return typeof value === "string" && (COLUMN_ROLES as readonly string[]).includes(value);
}

export interface Column {
  name: string;
  type: ColumnType;
  /** Set on columns written by the metrics compute step. */
  computed?: boolean;
  role?: ColumnRole;
}

/** A named grid of rows. Column types are inferred once, at import. */
export interface Table {
  name: string;
  columns: Column[];
  rows: Row[];
}

/** Every table found in an imported file, before one is chosen as the edge list. */
export interface Dataset {
  fileName: string;
  tables: Table[];
  /**
   * Set when the file held more rows than were read. Formats that routinely
   * carry millions of rows are capped, and the gap is reported rather than
   * left to look like the whole file.
   */
  truncated?: { read: number; total: number };
}

export interface Mapping {
  source: string;
  target: string;
  /** Columns shown as edge details in tooltips and the inspector. */
  attrs: string[];
  /**
   * Node table columns shown as node details in tooltips and the inspector.
   * Absent means every column but the id, which is what `attrs` starts as on
   * its side; an empty array means none, chosen deliberately.
   */
  nodeAttrs?: string[];
}

/**
 * The working document: an edge list plus a node list that always exists, so
 * nodes can carry their own attributes and outlive the edges that named them.
 */
export interface GraphDoc {
  name: string;
  edges: Table;
  nodes: Table;
  /** Column of `nodes` holding the node id, matched against the edge endpoints. */
  nodeIdColumn: string;
  mapping: Mapping;
  /**
   * False when the node table was derived from the edge endpoints and has never
   * been edited. Drives whether isolated nodes show by default.
   */
  nodesDeclared: boolean;
}

/**
 * Appearance settings, Gephi style. Column-driven options are encoded as
 * "column:<name>" so they can't collide with the built-in metric tokens, or as
 * "cell:<name>" when the column already holds the answer rather than a value to
 * map. The palette fields come from `PaletteChoice`: a shipped set by id, or
 * "custom" with the colors carried here, so styling travels with the workspace.
 */
/**
 * What a node of one type wears. A type is a value of the chosen type column,
 * and every channel here replaces what the global rules computed for the
 * nodes carrying that value; the ones left unset keep the rule's answer.
 */
export interface NodeTypeStyle {
  /** #rrggbb, worn instead of the palette slot. */
  color?: string;
  /** Pixel radius, worn instead of the size rule's answer. */
  size?: number;
  /** One image source for the whole type, vetted like a cell would be. */
  image?: string;
  /** Node column of display names for this type's nodes alone. */
  labelColumn?: string;
  /** Node columns shown on hover and in the details for this type alone. */
  attrs?: string[];
}

/** The edge side of the same idea: color, stroke width, hover details. */
export interface EdgeTypeStyle {
  /** #rrggbb, painted instead of the palette slot. */
  color?: string;
  /** Stroke width in pixels, instead of the width rule's answer. */
  width?: number;
  /** Edge columns shown on hover and in the details for this type alone. */
  attrs?: string[];
}

/**
 * Per-type styling: one column whose values name the kinds of mark, and an
 * override per value. When the same column also drives the color channel, the
 * legend keys line up and its swatches show the overridden colors.
 */
export interface TypeStyles<T> {
  column: string;
  /** Keyed by cell value: null-prototype, read with `Object.hasOwn`. */
  styles: Record<string, T>;
}

export interface GraphStyle extends PaletteChoice {
  /** 'none' | 'metric:degree' | 'column:<name>' | 'cell:<name>' */
  nodeColor: string;
  /**
   * 'metric:degree' | 'metric:in' | 'metric:out' | 'metric:uniform' |
   * 'column:<name>' | 'cell:<name>'
   */
  nodeSize: string;
  /** 'none' | 'column:<name>' naming a column of image data or URLs. */
  nodeImage: string;
  /**
   * 'none' | 'column:<name>' naming a node table column of display names.
   * 'none' labels nodes with their ids; a cell with nothing in it does too.
   */
  nodeLabel: string;
  /** 'uniform' | 'column:<name>' | 'cell:<name>' */
  edgeWidth: string;
  /** 'uniform' | 'column:<name>' | 'cell:<name>' */
  edgeColor: string;
  arrows: boolean;
  /** Multiplier applied to layout distances, 0.6 to 1.8. */
  spacing: number;
  typeStyles?: TypeStyles<NodeTypeStyle>;
  edgeTypeStyles?: TypeStyles<EdgeTypeStyle>;
}

export const DEFAULT_STYLE: GraphStyle = {
  nodeColor: "none",
  nodeSize: "metric:degree",
  nodeImage: "none",
  nodeLabel: "none",
  edgeWidth: "uniform",
  edgeColor: "uniform",
  arrows: true,
  spacing: 1,
  palette: DEFAULT_PALETTE,
  ramp: DEFAULT_RAMP,
};

/** The column name inside a "column:<name>" or "cell:<name>" token, or null. */
export function styleColumn(token: string): string | null {
  if (token.startsWith("column:")) return token.slice(7);
  if (token.startsWith("cell:")) return token.slice(5);
  return null;
}

/**
 * Whether the column drives the mark directly: its cells are colors to paint
 * or pixel sizes, not values to put on a palette or a scale.
 */
export function isCellStyle(token: string): boolean {
  return token.startsWith("cell:");
}

export type ColumnFilter =
  | { kind: "values"; selected: string[] }
  | { kind: "range"; min: number | null; max: number | null };

export type Filters = Record<string, ColumnFilter>;

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  /** What the node is called on screen: a label column's cell, or the id. */
  label: string;
  /** The node table row this node came from. */
  row: Row;
  /** Partition value when nodes are colored by a categorical column. */
  group: string | null;
  /** Ranking value when nodes are colored by a numeric metric. */
  value: number | null;
  /** The color the node's own cell asked for, when a color column drives it. */
  color: string | null;
  /** Ready-to-render image source when an image column is mapped. */
  image: string | null;
  inDegree: number;
  outDegree: number;
  degree: number;
  radius: number;
  /** Layout target position, used by the static layouts. */
  tx?: number;
  ty?: number;
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  /** Original spreadsheet rows merged into this edge. */
  rows: Row[];
  /** Mean of the mapped edge-width column, or null. */
  weight: number | null;
  /** Value of the edge-color column, or null. */
  colorValue: string | null;
  /** The color the edge's own cells asked for, when a color column drives it. */
  color: string | null;
  /** A stroke width in pixels that skips the scale, or null for the rule's. */
  width: number | null;
  /** True when the reverse edge also exists; rendered as an arc. */
  curve: boolean;
}

/** Structure only, before any appearance settings are applied. */
export interface BaseGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Edge rows behind the surviving links, in original order. */
  rows: Row[];
  /** Rows dropped for missing endpoints or self-loops. */
  skippedRows: number;
}

export interface Graph extends BaseGraph {
  /** Distinct node partition values, most frequent first. */
  groups: string[];
  /** Distinct edge color values, most frequent first. */
  edgeGroups: string[];
  /** Present when node color is a numeric ranking; range of node.value. */
  ranking: { min: number; max: number } | null;
}

/**
 * What the canvas and the tables are pointed at. A link merges every row with
 * the same pair of endpoints, so an edge selection names the pair rather than
 * one row, and more than one row can answer to it.
 */
export type GraphSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; source: string; target: string };

export const nodeSelection = (id: string): GraphSelection => ({ kind: "node", id });

/** The selected node, or null when nothing or an edge is selected. */
export function selectedNode(selection: GraphSelection | null): string | null {
  return selection?.kind === "node" ? selection.id : null;
}

export function sameSelection(a: GraphSelection | null, b: GraphSelection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "node") return b.kind === "node" && a.id === b.id;
  return b.kind === "edge" && a.source === b.source && a.target === b.target;
}

export type LabelMode = "auto" | "all" | "none";

/**
 * Everything the stage draws on top of the graph. Each one can be dismissed on
 * its own, from its own corner × or from the View menu, and "Show everything"
 * puts them all back.
 */
export const OVERLAYS = ["toolbar", "legend"] as const;
export type Overlay = (typeof OVERLAYS)[number];

/**
 * The three panels around the stage. Unlike the overlays these take their own
 * room rather than covering the graph, so collapsing one gives the graph the
 * space back. Each has an edge tab of its own and a line in the View menu.
 */
export const PANELS = ["sidebar", "table", "stats"] as const;
export type Panel = (typeof PANELS)[number];

/** Which corner of the stage an overlay is parked in; it is dragged between them. */
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
