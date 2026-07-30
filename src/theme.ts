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

/**
 * CSS color names, name and hex packed into one string so the table reads as a
 * table and the formatter leaves it alone. Grey spellings are folded onto the
 * gray ones on lookup rather than listed twice.
 */
const NAMED_COLORS =
  "black 000000,white ffffff,silver c0c0c0,gray 808080,darkgray a9a9a9,lightgray d3d3d3," +
  "dimgray 696969,slategray 708090,darkslategray 2f4f4f,whitesmoke f5f5f5,snow fffafa," +
  "ivory fffff0,beige f5f5dc,azure f0ffff,aliceblue f0f8ff,antiquewhite faebd7," +
  "red ff0000,darkred 8b0000,firebrick b22222,crimson dc143c,tomato ff6347,coral ff7f50," +
  "salmon fa8072,lightsalmon ffa07a,lightcoral f08080,maroon 800000,brown a52a2a," +
  "orange ffa500,darkorange ff8c00,gold ffd700,yellow ffff00,lightyellow ffffe0," +
  "khaki f0e68c,goldenrod daa520,wheat f5deb3,tan d2b48c,sandybrown f4a460," +
  "peru cd853f,chocolate d2691e,sienna a0522d,olive 808000,olivedrab 6b8e23," +
  "green 008000,darkgreen 006400,forestgreen 228b22,seagreen 2e8b57," +
  "mediumseagreen 3cb371,limegreen 32cd32,lime 00ff00,lightgreen 90ee90," +
  "springgreen 00ff7f,yellowgreen 9acd32,mintcream f5fffa,teal 008080,darkcyan 008b8b," +
  "aqua 00ffff,cyan 00ffff,turquoise 40e0d0,lightblue add8e6,skyblue 87ceeb," +
  "steelblue 4682b4,cornflowerblue 6495ed,dodgerblue 1e90ff,royalblue 4169e1," +
  "blue 0000ff,darkblue 00008b,navy 000080,midnightblue 191970,slateblue 6a5acd," +
  "mediumslateblue 7b68ee,mediumpurple 9370db,purple 800080,rebeccapurple 663399," +
  "indigo 4b0082,darkviolet 9400d3,violet ee82ee,orchid da70d6,darkmagenta 8b008b," +
  "magenta ff00ff,fuchsia ff00ff,plum dda0dd,thistle d8bfd8,lavender e6e6fa," +
  "pink ffc0cb,hotpink ff69b4,deeppink ff1493";

let namedColors: Map<string, string> | null = null;

function namedColor(name: string): string | null {
  if (namedColors === null) {
    namedColors = new Map();
    for (const entry of NAMED_COLORS.split(",")) {
      const [key, hex] = entry.split(" ");
      namedColors.set(key, `#${hex}`);
    }
  }
  return namedColors.get(name.replaceAll("grey", "gray")) ?? null;
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v: number) => byte(v).toString(16).padStart(2, "0");

/**
 * A cell read as a color: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` or a
 * CSS color name. Everything comes back as plain `#rrggbb`, since that is what
 * the rest of the app and the GEXF writer expect, and anything else comes back
 * null: a cell is untrusted text, and it is about to become an SVG attribute.
 */
export function parseColor(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim().toLowerCase();
  if (text === "") return null;

  const hash = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hash) {
    const digits = hash[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = [...digits.slice(0, 3)];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    // Alpha is dropped: marks carry their own opacity, and a translucent node
    // would not survive the round trip through GEXF or a PNG export.
    if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`;
    return null;
  }

  const parens = /^rgba?\(([^)]*)\)$/.exec(text);
  if (parens) {
    const parts = parens[1].split(/[\s,/]+/).filter((p) => p !== "");
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((p) => {
      const scale = p.endsWith("%") ? 2.55 : 1;
      const n = Number(p.endsWith("%") ? p.slice(0, -1) : p);
      return isFinite(n) ? n * scale : NaN;
    });
    if (channels.some((c) => isNaN(c))) return null;
    return `#${channels.map(hex2).join("")}`;
  }

  return /^[a-z]+$/.test(text) ? namedColor(text) : null;
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
