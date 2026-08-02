import { expect, test } from "vitest";
import type { Row, Table } from "../types";
import { buildDoc } from "./doc";
import { timeColumns } from "./timeline";

function docWith(edgeColumns: Table["columns"], edgeRows: Row[]) {
  const edges: Table = {
    name: "Edges",
    columns: [{ name: "From", type: "text" }, { name: "To", type: "text" }, ...edgeColumns],
    rows: edgeRows.map((r) => ({ From: "a", To: "b", ...r })),
  };
  return buildDoc("t", edges, { mapping: { source: "From", target: "To", attrs: [] } });
}

test("dated text columns are offered, prose is not", () => {
  const doc = docWith(
    [
      { name: "When", type: "text" },
      { name: "Notes", type: "text" },
    ],
    [
      { When: "2024-01-05", Notes: "fine" },
      { When: "2024-02-11", Notes: "also fine" },
    ],
  );
  expect(timeColumns(doc).map((c) => c.column)).toEqual(["When"]);
  expect(timeColumns(doc)[0].dates).toBe(true);
});

test("number columns are offered only when they read as a time axis", () => {
  const doc = docWith(
    [
      { name: "Year", type: "number" },
      { name: "Epoch", type: "number" },
      { name: "Meetings per month", type: "number" },
      { name: "Years together", type: "number" },
    ],
    [
      { Year: 1999, Epoch: 1704067200000, "Meetings per month": 4, "Years together": 3 },
      { Year: 2011, Epoch: 1706745600000, "Meetings per month": 2, "Years together": 7 },
    ],
  );
  // Years and epochs are moments; rates and durations are measurements, and
  // a timeline over a measurement would be nonsense wearing an axis.
  expect(timeColumns(doc).map((c) => c.column)).toEqual(["Year", "Epoch"]);
});

test("structural columns never become a timeline", () => {
  const doc = docWith([], [{}]);
  expect(timeColumns(doc)).toEqual([]);
});
