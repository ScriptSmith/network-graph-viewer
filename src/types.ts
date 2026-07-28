import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";

export type CellValue = string | number | boolean | null;
export type Row = Record<string, CellValue>;

export type ColumnType = "text" | "number" | "bool";

export interface Column {
  name: string;
  type: ColumnType;
  /** Set on columns written by the metrics compute step. */
  computed?: boolean;
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
}

export interface Mapping {
  source: string;
  target: string;
  /** Columns shown as edge details in tooltips and the inspector. */
  attrs: string[];
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
 * "column:<name>" so they can't collide with the built-in metric tokens.
 */
export interface GraphStyle {
  /** 'none' | 'metric:degree' | 'column:<name>' */
  nodeColor: string;
  /** 'metric:degree' | 'metric:in' | 'metric:out' | 'metric:uniform' | 'column:<name>' */
  nodeSize: string;
  /** 'uniform' | 'column:<name>' */
  edgeWidth: string;
  /** 'uniform' | 'column:<name>' */
  edgeColor: string;
  arrows: boolean;
  /** Multiplier applied to layout distances, 0.6 to 1.8. */
  spacing: number;
}

export const DEFAULT_STYLE: GraphStyle = {
  nodeColor: "none",
  nodeSize: "metric:degree",
  edgeWidth: "uniform",
  edgeColor: "uniform",
  arrows: true,
  spacing: 1,
};

/** The column name inside a "column:<name>" token, or null. */
export function styleColumn(token: string): string | null {
  return token.startsWith("column:") ? token.slice(7) : null;
}

export type ColumnFilter =
  | { kind: "values"; selected: string[] }
  | { kind: "range"; min: number | null; max: number | null };

export type Filters = Record<string, ColumnFilter>;

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  /** The node table row this node came from. */
  row: Row;
  /** Partition value when nodes are colored by a categorical column. */
  group: string | null;
  /** Ranking value when nodes are colored by a numeric metric. */
  value: number | null;
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

export type LabelMode = "auto" | "all" | "none";
