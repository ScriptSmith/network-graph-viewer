/**
 * Graph color tokens. Marks are styled with explicit attributes (not CSS)
 * so exported SVGs look identical to the live canvas.
 *
 * The default categorical palette is a CVD-validated eight-slot set stepped
 * for the dark surface; slot order is part of the validation, don't shuffle
 * it. The other shipped sets are picked the same way: published
 * colorblind-safe sets, or tints chosen to sit on this surface.
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

/** A pickable set of colors: categorical slots, or the stops of a ramp. */
export interface ColorSet {
  id: string;
  name: string;
  colors: string[];
}

/** Stands for the colors carried in the style rather than a shipped set. */
export const CUSTOM = "custom";

export const DEFAULT_PALETTE = "default";
export const DEFAULT_RAMP = "blue";

/**
 * Categorical palettes. Okabe-Ito and Tol bright are the published
 * colorblind-safe sets, minus the near-black slots that would disappear here;
 * Glow is a set of light tints for graphs read on a dark screen.
 */
export const PALETTES: ColorSet[] = [
  { id: DEFAULT_PALETTE, name: "Default", colors: CATEGORICAL },
  {
    id: "okabe",
    name: "Okabe-Ito",
    colors: ["#56b4e9", "#e69f00", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7"],
  },
  {
    id: "tol",
    name: "Tol bright",
    colors: ["#4477aa", "#ee6677", "#228833", "#ccbb44", "#66ccee", "#aa3377", "#bbbbbb"],
  },
  {
    id: "glow",
    name: "Glow",
    colors: [
      "#7fb3ff",
      "#ffb166",
      "#5fd3a6",
      "#ffe066",
      "#ff9ec4",
      "#a9e06a",
      "#c3b2ff",
      "#ff8f8f",
    ],
  },
];

/** Ranking ramps. Every first stop clears the 2:1 floor against the surface. */
export const RAMPS: ColorSet[] = [
  { id: DEFAULT_RAMP, name: "Blue", colors: SEQUENTIAL },
  {
    id: "ember",
    name: "Ember",
    colors: ["#8f3212", "#b8480f", "#d95926", "#e7893a", "#f0b360", "#f8e0a2"],
  },
  {
    id: "viridis",
    name: "Viridis",
    colors: ["#414487", "#2a788e", "#22a884", "#7ad151", "#bddf26", "#fde725"],
  },
  {
    id: "grey",
    name: "Grey",
    colors: ["#55534c", "#74716a", "#938f86", "#b3aea3", "#d3cdc1", "#f0eee6"],
  },
];

/**
 * The color half of a style: a shipped set by id, or `custom` with the colors
 * carried alongside, so a shared link brings its palette with it.
 */
export interface PaletteChoice {
  palette: string;
  ramp: string;
  customPalette?: string[];
  customRamp?: string[];
}

/** Colors as the rest of the app wants them: two plain arrays. */
export interface Palette {
  categorical: string[];
  sequential: string[];
}

export const DEFAULT_COLORS: Palette = { categorical: CATEGORICAL, sequential: SEQUENTIAL };

/**
 * Colors reach SVG attributes and inline styles, and a workspace can arrive
 * from a link anyone wrote, so only plain six-digit hex is let through.
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function chosen(sets: ColorSet[], id: string, custom: string[] | undefined, fallback: string[]) {
  if (id === CUSTOM) {
    const clean = (Array.isArray(custom) ? custom : []).filter(isHexColor);
    return clean.length > 0 ? clean : fallback;
  }
  return sets.find((s) => s.id === id)?.colors ?? fallback;
}

export function resolvePalette(choice: PaletteChoice): Palette {
  return {
    categorical: chosen(PALETTES, choice.palette, choice.customPalette, CATEGORICAL),
    sequential: chosen(RAMPS, choice.ramp, choice.customRamp, SEQUENTIAL),
  };
}

export function sequentialColor(t: number, ramp: string[] = SEQUENTIAL): string {
  const stops = ramp.length > 0 ? ramp : SEQUENTIAL;
  const clamped = Math.max(0, Math.min(1, t));
  return stops[Math.min(stops.length - 1, Math.floor(clamped * stops.length))];
}

/** Nodes with no group value, and groups folded into "Other". */
export const NEUTRAL = "#898781";

export const EDGE = "#45443f";
export const EDGE_LIT = "#d8d6cc";
export const LABEL = "#c9c7bc";
export const LABEL_HALO = SURFACE;
export const SELECT_RING = "#f4f3ee";

/** Groups past the palette's last slot get folded into "Other". */
export const OTHER_GROUP = "Other";

export function groupColorMap(
  groups: string[],
  categorical: string[] = CATEGORICAL,
): Map<string, string> {
  const map = new Map<string, string>();
  groups.slice(0, categorical.length).forEach((g, i) => map.set(g, categorical[i]));
  return map;
}

export function nodeColor(
  group: string | null,
  colors: Map<string, string>,
  categorical: string[] = CATEGORICAL,
): string {
  if (group === null) return colors.size > 0 ? NEUTRAL : categorical[0];
  return colors.get(group) ?? NEUTRAL;
}

/** In-graph text uses system fonts so exports render identically everywhere. */
export const GRAPH_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
