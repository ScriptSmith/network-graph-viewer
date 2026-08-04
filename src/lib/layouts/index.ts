import type { BaseGraph } from "../../types";
import { circlePackLayout } from "./circlepack";
import { FORCE_ATLAS_2_DEFAULTS } from "./forceatlas2";
import { projectGeo } from "./geo";
import { circleLayout, gridLayout, hierarchyLayout, radialLayout } from "./static";

export interface Point {
  x: number;
  y: number;
}

export type LayoutId =
  | "force"
  | "forceatlas2"
  | "gpu"
  | "hierarchy"
  | "radial"
  | "circle"
  | "grid"
  | "circlepack"
  | "geo"
  | "script";

export type ParamValue = number | boolean | string;
export type LayoutParams = Record<string, ParamValue>;

export type LayoutParam =
  | {
      key: string;
      name: string;
      kind: "number";
      min: number;
      max: number;
      step: number;
      default: number;
    }
  | { key: string; name: string; kind: "boolean"; default: boolean; blurb?: string }
  /** Picks a column from one of the tables; "" means none. */
  | {
      key: string;
      name: string;
      kind: "column";
      scope: "nodes" | "edges";
      default: string;
      /** Offer number columns only; a latitude is not a name. */
      numeric?: boolean;
    };

export interface LayoutDefinition {
  id: LayoutId;
  name: string;
  blurb: string;
  /**
   * Where the node positions come from: `physics` runs a simulation with no
   * targets at all, `computed` derives targets from the graph, `external`
   * takes them from somewhere else entirely, which today means a user script,
   * and `renderer` hands the whole simulation to the renderer, which today
   * means cosmos.gl's GPU physics under the WebGL renderer. Anywhere the
   * renderer cannot run it, a `renderer` layout falls back to plain force.
   */
  positions: "physics" | "computed" | "external" | "renderer";
  params: LayoutParam[];
}

export const LAYOUTS: LayoutDefinition[] = [
  {
    id: "force",
    name: "Force",
    blurb: "Physics simulation, clusters emerge",
    positions: "physics",
    params: [],
  },
  {
    id: "forceatlas2",
    name: "ForceAtlas2",
    blurb: "Gephi's layout: hubs ringed by their neighbours",
    positions: "physics",
    params: [
      {
        key: "scaling",
        name: "Repulsion",
        kind: "number",
        min: 50,
        max: 3000,
        step: 25,
        default: 300,
      },
      { key: "gravity", name: "Gravity", kind: "number", min: 0, max: 10, step: 0.1, default: 1 },
      {
        key: "edgeWeightInfluence",
        name: "Edge weight influence",
        kind: "number",
        min: 0,
        max: 2,
        step: 0.1,
        default: 1,
      },
      {
        key: "linLog",
        name: "LinLog mode",
        kind: "boolean",
        default: false,
        blurb: "Tightens clusters and pushes them further apart",
      },
      {
        key: "strongGravity",
        name: "Strong gravity",
        kind: "boolean",
        default: false,
        blurb: "Pulls harder the further out a node drifts",
      },
      { key: "weightColumn", name: "Edge weight", kind: "column", scope: "edges", default: "" },
    ],
  },
  {
    id: "gpu",
    name: "Force (GPU)",
    blurb: "cosmos.gl's simulation on the graphics card, for very large graphs",
    positions: "renderer",
    params: [],
  },
  {
    id: "hierarchy",
    name: "Hierarchy",
    blurb: "Layered top-down from the roots",
    positions: "computed",
    params: [],
  },
  {
    id: "radial",
    name: "Radial",
    blurb: "Rings by distance from the roots",
    positions: "computed",
    params: [],
  },
  {
    id: "circle",
    name: "Circle",
    blurb: "Everyone on one ring, grouped",
    positions: "computed",
    params: [],
  },
  {
    id: "grid",
    name: "Grid",
    blurb: "Rows and columns by connections",
    positions: "computed",
    params: [],
  },
  {
    id: "geo",
    name: "Geographic",
    blurb: "Nodes at their real coordinates, no basemap",
    positions: "computed",
    params: [
      {
        key: "latColumn",
        name: "Latitude",
        kind: "column",
        scope: "nodes",
        default: "",
        numeric: true,
      },
      {
        key: "lonColumn",
        name: "Longitude",
        kind: "column",
        scope: "nodes",
        default: "",
        numeric: true,
      },
    ],
  },
  {
    id: "script",
    name: "Scripted",
    blurb: "Positions from the last layout script you ran",
    positions: "external",
    params: [],
  },
  {
    id: "circlepack",
    name: "Circle pack",
    blurb: "One disc per group, packed together",
    positions: "computed",
    params: [
      { key: "groupBy", name: "Group by", kind: "column", scope: "nodes", default: "" },
      { key: "padding", name: "Padding", kind: "number", min: 0, max: 24, step: 1, default: 4 },
    ],
  },
];

export function layoutDefinition(id: LayoutId): LayoutDefinition {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

/** Whether a value names a layout. A workspace can arrive from a link anyone wrote. */
export function isLayoutId(value: unknown): value is LayoutId {
  return typeof value === "string" && LAYOUTS.some((l) => l.id === value);
}

export function defaultParams(id: LayoutId): LayoutParams {
  const params: LayoutParams = {};
  for (const param of layoutDefinition(id).params) params[param.key] = param.default;
  return params;
}

function num(params: LayoutParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" ? value : fallback;
}

function bool(params: LayoutParams, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function str(params: LayoutParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
}

export function layoutWeightColumn(params: LayoutParams): string | null {
  return str(params, "weightColumn", "") || null;
}

/**
 * Resolve ForceAtlas2 settings, folding in the global spacing control.
 * Equilibrium distance goes as the square root of scaling, so spacing is
 * squared to make it a linear multiplier on how far apart things end up.
 */
export function forceAtlas2Params(params: LayoutParams, spacing = 1) {
  return {
    scaling: num(params, "scaling", FORCE_ATLAS_2_DEFAULTS.scaling) * spacing * spacing,
    gravity: num(params, "gravity", FORCE_ATLAS_2_DEFAULTS.gravity),
    strongGravity: bool(params, "strongGravity", FORCE_ATLAS_2_DEFAULTS.strongGravity),
    linLog: bool(params, "linLog", FORCE_ATLAS_2_DEFAULTS.linLog),
    edgeWeightInfluence: num(
      params,
      "edgeWeightInfluence",
      FORCE_ATLAS_2_DEFAULTS.edgeWeightInfluence,
    ),
  };
}

/**
 * Target positions for the layouts that place nodes directly, or null for the
 * simulated ones, which have no targets because physics decides where things
 * end up. Coordinates are centered on the origin; the canvas fits the view.
 */
export function computeTargets(
  id: LayoutId,
  params: LayoutParams,
  graph: BaseGraph,
): Map<string, Point> | null {
  switch (id) {
    case "force":
    case "forceatlas2":
      return null;
    case "gpu":
      // The renderer owns it; everywhere else it behaves as plain force.
      return null;
    case "circle":
      return circleLayout(graph);
    case "grid":
      return gridLayout(graph);
    case "hierarchy":
      return hierarchyLayout(graph);
    case "radial":
      return radialLayout(graph);
    case "script":
      // Supplied by the caller, which holds the script's output.
      return null;
    case "circlepack":
      return circlePackLayout(graph, {
        groupBy: str(params, "groupBy", ""),
        padding: num(params, "padding", 4),
      });
    case "geo":
      return projectGeo(graph, str(params, "latColumn", ""), str(params, "lonColumn", "")).targets;
  }
}

export { forceAtlas2, type ForceAtlas2Params } from "./forceatlas2";
export { mercator, projectGeo, MERCATOR_LAT_LIMIT } from "./geo";
export { labelNoverlap, noverlap, NOVERLAP_DEFAULTS, type NoverlapOptions } from "./noverlap";
export { nodeDepths } from "./static";
