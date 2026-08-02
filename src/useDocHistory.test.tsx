/**
 * @vitest-environment jsdom
 *
 * The history hook now carries the edits overlay with each step, and the
 * promise under test is the one item 13 leans on: undoing an edit rewinds
 * the overlay along with the document, and an "update data" step swaps the
 * document without touching the overlay at all.
 */
import { afterEach, expect, test } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GraphDoc, Row, Table } from "./types";
import { buildDoc } from "./lib/doc";
import { setCell } from "./lib/edit";
import { compoundKey } from "./lib/cells";
import { useDocHistory, type DocHistory } from "./useDocHistory";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function docOf(): GraphDoc {
  const rows: Row[] = [{ Source: "A", Target: "B", Weight: 1 }];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "Weight", type: "number" },
    ],
    rows,
  };
  return buildDoc("test", edges, {
    mapping: { source: "Source", target: "Target", attrs: ["Weight"] },
  });
}

function mount(): { current: () => DocHistory } {
  const seen: { history: DocHistory | null } = { history: null };
  function Probe() {
    seen.history = useDocHistory();
    return null;
  }
  const host = document.createElement("div");
  act(() => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  return { current: () => seen.history as DocHistory };
}

test("undo rewinds the overlay with the document, and redo brings both back", () => {
  const probe = mount();
  const doc = docOf();
  act(() => probe.current().reset(doc));

  act(() => probe.current().edit("the cell edit", (d) => setCell(d, "edges", 0, "Weight", 9)));
  const dirty = compoundKey("edges", "A", "B", 0, "Weight");
  expect(probe.current().doc?.edges.rows[0].Weight).toBe(9);
  expect(probe.current().overlay.dirtyCells.has(dirty)).toBe(true);

  act(() => probe.current().undo());
  expect(probe.current().doc?.edges.rows[0].Weight).toBe(1);
  expect(probe.current().overlay.dirtyCells.size).toBe(0);

  act(() => probe.current().redo());
  expect(probe.current().doc?.edges.rows[0].Weight).toBe(9);
  expect(probe.current().overlay.dirtyCells.has(dirty)).toBe(true);
});

test("a keep-mode step changes the document without touching the overlay", () => {
  const probe = mount();
  const doc = docOf();
  act(() => probe.current().reset(doc));
  act(() => probe.current().edit("the cell edit", (d) => setCell(d, "edges", 0, "Weight", 9)));
  const before = probe.current().overlay;

  const swapped = docOf();
  act(() => probe.current().edit("updating the data", () => swapped, "keep"));
  expect(probe.current().doc).toBe(swapped);
  expect(probe.current().overlay).toBe(before);

  // And undoing the update restores the previous document with the same
  // overlay still in force.
  act(() => probe.current().undo());
  expect(probe.current().doc?.edges.rows[0].Weight).toBe(9);
  expect(probe.current().overlay).toBe(before);
});

test("reset clears the overlay unless one is handed in", () => {
  const probe = mount();
  act(() => probe.current().reset(docOf()));
  act(() => probe.current().edit("the cell edit", (d) => setCell(d, "edges", 0, "Weight", 9)));
  expect(probe.current().overlay.dirtyCells.size).toBe(1);
  act(() => probe.current().reset(docOf()));
  expect(probe.current().overlay.dirtyCells.size).toBe(0);
});
