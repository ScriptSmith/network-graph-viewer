/**
 * Graph color tokens. Marks are styled with explicit attributes (not CSS)
 * so exported SVGs look identical to the live canvas.
 *
 * The categorical palette is a CVD-validated eight-slot set stepped for the
 * dark surface; slot order is part of the validation, don't shuffle it.
 */
export const SURFACE = "#1a1a19";

export const CATEGORICAL = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
];

/**
 * Sequential ramp for numeric rankings, one blue hue stepped light on the
 * dark surface: low values recede, high values pop. The darkest step stays
 * above the 2:1 ordinal floor so every node remains visible.
 */
export const SEQUENTIAL = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"];

export function sequentialColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return SEQUENTIAL[Math.min(SEQUENTIAL.length - 1, Math.floor(clamped * SEQUENTIAL.length))];
}

/** Nodes with no group value, and groups folded into "Other". */
export const NEUTRAL = "#898781";

export const EDGE = "#45443f";
export const EDGE_LIT = "#d8d6cc";
export const LABEL = "#c9c7bc";
export const LABEL_HALO = SURFACE;
export const SELECT_RING = "#f4f3ee";

/** Groups beyond this many get folded into "Other" (palette has 8 slots). */
export const MAX_GROUPS = 7;
export const OTHER_GROUP = "Other";

export function groupColorMap(groups: string[]): Map<string, string> {
  const map = new Map<string, string>();
  groups.slice(0, MAX_GROUPS).forEach((g, i) => map.set(g, CATEGORICAL[i]));
  return map;
}

export function nodeColor(group: string | null, colors: Map<string, string>): string {
  if (group === null) return colors.size > 0 ? NEUTRAL : CATEGORICAL[0];
  return colors.get(group) ?? NEUTRAL;
}

/** In-graph text uses system fonts so exports render identically everywhere. */
export const GRAPH_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
