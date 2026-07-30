import { expect, test } from "vitest";
import {
  CATEGORICAL,
  CUSTOM,
  DEFAULT_PALETTE,
  DEFAULT_RAMP,
  PALETTES,
  RAMPS,
  SEQUENTIAL,
  groupColorMap,
  isHexColor,
  parseColor,
  resolvePalette,
  sequentialColor,
} from "./theme";

const choice = (over: Partial<Parameters<typeof resolvePalette>[0]> = {}) => ({
  palette: DEFAULT_PALETTE,
  ramp: DEFAULT_RAMP,
  ...over,
});

test("shipped sets are plain six-digit hex", () => {
  for (const set of [...PALETTES, ...RAMPS]) {
    expect(set.colors.length).toBeGreaterThan(1);
    expect(set.colors.every(isHexColor)).toBe(true);
  }
});

test("a style resolves to the set it names", () => {
  expect(resolvePalette(choice())).toEqual({
    categorical: CATEGORICAL,
    sequential: SEQUENTIAL,
  });
  expect(resolvePalette(choice({ palette: "okabe" })).categorical).toEqual(
    PALETTES.find((p) => p.id === "okabe")?.colors,
  );
  // A set that no longer ships, from an older link, falls back rather than
  // leaving the graph with nothing to draw with.
  expect(resolvePalette(choice({ palette: "gone", ramp: "gone" }))).toEqual({
    categorical: CATEGORICAL,
    sequential: SEQUENTIAL,
  });
});

test("custom colors are used, and junk in them is dropped", () => {
  const custom = ["#112233", "#445566"];
  expect(resolvePalette(choice({ palette: CUSTOM, customPalette: custom })).categorical).toEqual(
    custom,
  );
  // A link is written by anyone, so anything that isn't a hex color goes.
  const dirty = ["#112233", "red", "url(#x)", "", "#GGGGGG"] as string[];
  expect(resolvePalette(choice({ palette: CUSTOM, customPalette: dirty })).categorical).toEqual([
    "#112233",
  ]);
  expect(resolvePalette(choice({ palette: CUSTOM, customPalette: [] })).categorical).toEqual(
    CATEGORICAL,
  );
  expect(resolvePalette(choice({ palette: CUSTOM, customPalette: undefined })).categorical).toEqual(
    CATEGORICAL,
  );
});

test("groups take palette slots in order and run out at its end", () => {
  const groups = ["a", "b", "c"];
  expect([...groupColorMap(groups, ["#111111", "#222222"])]).toEqual([
    ["a", "#111111"],
    ["b", "#222222"],
  ]);
  expect(groupColorMap(groups).get("a")).toBe(CATEGORICAL[0]);
});

test("a cell reads as a color, or does not", () => {
  expect(parseColor("#B7410E")).toBe("#b7410e");
  expect(parseColor("  #b41  ")).toBe("#bb4411");
  // Alpha is dropped rather than carried into a hex the app can't round-trip.
  expect(parseColor("#b7410e80")).toBe("#b7410e");
  expect(parseColor("#b418")).toBe("#bb4411");
  expect(parseColor("rgb(183, 65, 14)")).toBe("#b7410e");
  expect(parseColor("rgba(183 65 14 / 0.5)")).toBe("#b7410e");
  expect(parseColor("rgb(100%, 0%, 0%)")).toBe("#ff0000");
  // Out-of-range channels clamp, the way a browser would take them.
  expect(parseColor("rgb(300, -20, 14)")).toBe("#ff000e");
  expect(parseColor("SteelBlue")).toBe("#4682b4");
  expect(parseColor("grey")).toBe(parseColor("gray"));

  // A cell is untrusted text on its way into an SVG attribute.
  for (const junk of [
    null,
    "",
    "   ",
    "url(#x)",
    "#GGGGGG",
    "#12345",
    "not a color",
    "rgb(a, b, c)",
    "rgb(1, 2)",
    "12",
    "red;fill:blue",
  ]) {
    expect(parseColor(junk)).toBeNull();
  }
});

test("a ranking steps along whichever ramp is in force", () => {
  const ramp = ["#000000", "#ffffff"];
  expect(sequentialColor(0, ramp)).toBe("#000000");
  expect(sequentialColor(0.99, ramp)).toBe("#ffffff");
  // Out-of-range values clamp rather than reading off the end.
  expect(sequentialColor(-1, ramp)).toBe("#000000");
  expect(sequentialColor(2, ramp)).toBe("#ffffff");
  expect(sequentialColor(1, ramp)).toBe("#ffffff");
  expect(sequentialColor(0.5)).toBe(SEQUENTIAL[3]);
});
