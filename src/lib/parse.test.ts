/**
 * Column role inference: a census strict enough that a wrong role never comes
 * out of it, since the role decides which affordances hang on every cell.
 */
import { expect, test } from "vitest";
import type { Row } from "../types";
import { inferColumns } from "./parse";

const rows: Row[] = [
  {
    Paint: "#b7410e",
    Site: "https://example.test/a",
    Pic: "https://example.test/a.png",
    Markup: "<svg viewBox='0 0 1 1'></svg>",
    Note: "likes red",
    Count: 3,
  },
  {
    Paint: "steelblue",
    Site: "https://example.test/b",
    Pic: "https://example.test/b.svg?v=2",
    Markup: "<svg viewBox='0 0 2 2'></svg>",
    Note: "red again",
    Count: 4,
  },
];

test("colors, links, image links and inline markup each earn their role", () => {
  const byName = new Map(
    inferColumns(rows, ["Paint", "Site", "Pic", "Markup", "Note", "Count"]).map((c) => [c.name, c]),
  );
  expect(byName.get("Paint")?.role).toBe("color");
  expect(byName.get("Site")?.role).toBe("url");
  expect(byName.get("Pic")?.role).toBe("image");
  expect(byName.get("Markup")?.role).toBe("image");
  expect(byName.get("Note")?.role).toBeUndefined();
  expect(byName.get("Count")?.role).toBeUndefined();
});

test("a column that is only mostly colors earns nothing", () => {
  const mixed: Row[] = [
    { Paint: "#b7410e" },
    { Paint: "#3987e5" },
    { Paint: "#e2762f" },
    { Paint: "reddish" },
  ];
  const [paint] = inferColumns(mixed, ["Paint"]);
  expect(paint.role).toBeUndefined();
});

test("one lonely value is not a census", () => {
  const [pic] = inferColumns([{ Pic: "https://example.test/a.png" }], ["Pic"]);
  expect(pic.role).toBeUndefined();
});
