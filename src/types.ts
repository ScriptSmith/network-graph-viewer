import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";

export type CellValue = string | number | boolean | null;
export type Row = Record<string, CellValue>;

export interface Sheet {
  name: string;
  columns: string[];
  rows: Row[];
}

export interface Dataset {
  fileName: string;
  sheets: Sheet[];
}

export interface Mapping {
  source: string;
  target: string;
  /** Columns shown as edge details in tooltips and the inspector. */
  attrs: string[];
  /** Numeric column driving edge stroke width, or null for uniform. */
  weight: string | null;
  /** Column whose value colors the target node, or null for a single hue. */
  color: string | null;
}

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  group: string | null;
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
  /** Mean of the mapped weight column, or null. */
  weight: number | null;
  /** True when the reverse edge also exists; rendered as an arc. */
  curve: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Distinct group values, most frequent first. */
  groups: string[];
  /** Rows dropped for missing endpoints or self-loops. */
  skippedRows: number;
}

export type LayoutId = "force" | "hierarchy" | "radial" | "circle" | "grid";
export type LabelMode = "auto" | "all" | "none";

export const LAYOUTS: { id: LayoutId; name: string; blurb: string }[] = [
  { id: "force", name: "Force", blurb: "Physics simulation, clusters emerge" },
  { id: "hierarchy", name: "Hierarchy", blurb: "Layered top-down from the roots" },
  { id: "radial", name: "Radial", blurb: "Rings by distance from the roots" },
  { id: "circle", name: "Circle", blurb: "Everyone on one ring, grouped" },
  { id: "grid", name: "Grid", blurb: "Rows and columns by connections" },
];
