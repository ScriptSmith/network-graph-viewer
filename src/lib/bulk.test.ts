import { expect, test } from "vitest";
import type { GraphDoc, GraphStyle, Row, Table } from "../types";
import { DEFAULT_STYLE } from "../types";
import { buildDoc, retargetStyle } from "./doc";
import { buildBaseGraph } from "./graph";
import { retargetChain, type FilterStep } from "./filter";
import {
  addColumn,
  compileReplace,
  deleteColumn,
  duplicateColumn,
  fillColumn,
  mergeNodes,
  renameColumn,
  renameValues,
  reorderColumns,
  replaceFailed,
  replaceInColumn,
  replaceMatches,
  retypeColumn,
  retypeLosses,
  type ReplaceSpec,
} from "./bulk";

const edges: Table = {
  name: "Edges",
  columns: [
    { name: "Source", type: "text" },
    { name: "Target", type: "text" },
    { name: "Weight", type: "number" },
    { name: "Kind", type: "text" },
  ],
  rows: [
    { Source: "Alex", Target: "Priya", Weight: 3, Kind: "mentors" },
    { Source: "Priya", Target: "Grace", Weight: 1, Kind: "Mentors" },
    { Source: "A. Rivera", Target: "Grace", Weight: 2, Kind: "reviews" },
  ],
};

const nodes: Table = {
  name: "Nodes",
  columns: [
    { name: "Id", type: "text" },
    { name: "Team", type: "text" },
    { name: "Note", type: "text" },
  ],
  rows: [
    { Id: "Alex", Team: "Research", Note: null },
    { Id: "Priya", Team: "Research", Note: "lead" },
    { Id: "Grace", Team: null, Note: null },
    { Id: "A. Rivera", Team: null, Note: "duplicate record" },
  ],
};

const clone = (table: Table): Table => ({ ...table, rows: table.rows.map((r) => ({ ...r })) });

const doc = (): GraphDoc =>
  buildDoc("test", clone(edges), {
    nodes: clone(nodes),
    mapping: { source: "Source", target: "Target", attrs: ["Weight", "Kind"] },
  });

const spec = (patch: Partial<ReplaceSpec> = {}): ReplaceSpec => ({
  find: "",
  replace: "",
  regex: false,
  caseSensitive: false,
  wholeCell: false,
  ...patch,
});

/** The compiled half of a spec, for the tests that assume it compiled. */
function replacer(patch: Partial<ReplaceSpec>) {
  const compiled = compileReplace(spec(patch));
  if (replaceFailed(compiled)) throw new Error(compiled.error);
  return compiled;
}

const column = (table: Table, name: string) => table.rows.map((r) => r[name]);
const ids = (d: GraphDoc) => d.nodes.rows.map((r) => r[d.nodeIdColumn]);

test("find and replace rewrites matching cells and leaves the rest alone", () => {
  // Replacing a whole value with nothing empties the cell rather than leaving
  // an empty string behind, so the column reads as blank everywhere it means it.
  const next = replaceInColumn(doc(), "edges", "Kind", null, replacer({ find: "mentors" }));
  expect(column(next.edges, "Kind")).toEqual([null, null, "reviews"]);
});

test("matching is case-insensitive until it is asked not to be", () => {
  const loose = replacer({ find: "mentors", replace: "guides" });
  const strict = replacer({ find: "mentors", replace: "guides", caseSensitive: true });
  expect(column(replaceInColumn(doc(), "edges", "Kind", null, loose).edges, "Kind")).toEqual([
    "guides",
    "guides",
    "reviews",
  ]);
  expect(column(replaceInColumn(doc(), "edges", "Kind", null, strict).edges, "Kind")).toEqual([
    "guides",
    "Mentors",
    "reviews",
  ]);
});

test("whole-cell matching will not fire on a substring", () => {
  const partial = replacer({ find: "views", replace: "read" });
  const whole = replacer({ find: "views", replace: "read", wholeCell: true });
  expect(column(replaceInColumn(doc(), "edges", "Kind", null, partial).edges, "Kind")[2]).toBe(
    "reread",
  );
  expect(column(replaceInColumn(doc(), "edges", "Kind", null, whole).edges, "Kind")[2]).toBe(
    "reviews",
  );
});

test("regex mode reads groups in the replacement, text mode reads a literal dollar", () => {
  const pattern = replacer({ find: "^(\\w)\\w*", replace: "$1.", regex: true });
  expect(column(replaceInColumn(doc(), "edges", "Kind", null, pattern).edges, "Kind")).toEqual([
    "m.",
    "M.",
    "r.",
  ]);

  const literal = replacer({ find: "reviews", replace: "$1 each" });
  expect(column(replaceInColumn(doc(), "edges", "Kind", null, literal).edges, "Kind")[2]).toBe(
    "$1 each",
  );
});

test("an unparseable pattern is reported, not thrown", () => {
  const compiled = compileReplace(spec({ find: "(unclosed", regex: true }));
  expect(replaceFailed(compiled)).toBe(true);
});

test("a replacement keeps a number column numeric", () => {
  const next = replaceInColumn(
    doc(),
    "edges",
    "Weight",
    null,
    replacer({ find: "3", replace: "9" }),
  );
  expect(next.edges.rows[0].Weight).toBe(9);
});

test("a scope confines the edit to the rows in it", () => {
  const before = doc();
  const scope = new Set<Row>([before.edges.rows[0]]);
  const next = replaceInColumn(before, "edges", "Kind", scope, replacer({ find: "mentors" }));
  expect(column(next.edges, "Kind")).toEqual([null, "Mentors", "reviews"]);
});

test("matches count exactly what an apply would change", () => {
  const before = doc();
  const found = replaceMatches(before.edges, "Kind", null, replacer({ find: "mentors" }));
  expect(found).toHaveLength(2);
});

test("renaming values folds several into one", () => {
  const next = renameValues(
    doc(),
    "edges",
    "Kind",
    new Map([
      ["mentors", "supervises"],
      ["Mentors", "supervises"],
    ]),
    null,
  );
  expect(column(next.edges, "Kind")).toEqual(["supervises", "supervises", "reviews"]);
});

test("renaming ids merges the nodes and rewires every edge that named them", () => {
  const next = renameValues(doc(), "nodes", "Id", new Map([["A. Rivera", "Alex"]]), null);
  expect(ids(next)).toEqual(["Alex", "Priya", "Grace"]);
  // The survivor keeps what it had and takes only what it was missing.
  const alex = next.nodes.rows[0];
  expect(alex.Team).toBe("Research");
  expect(alex.Note).toBe("duplicate record");
  expect(next.edges.rows.map((r) => r.Source)).toEqual(["Alex", "Priya", "Alex"]);
  expect(buildBaseGraph(next).nodes).toHaveLength(3);
});

test("merging nodes is the same act by another name", () => {
  const merged = mergeNodes(doc(), ["Alex", "A. Rivera"], "Alex");
  expect(ids(merged)).toEqual(["Alex", "Priya", "Grace"]);
  expect(merged.edges.rows[2].Source).toBe("Alex");
});

test("editing an endpoint column introduces the node it now names", () => {
  const next = renameValues(doc(), "edges", "Target", new Map([["Grace", "Grace O."]]), null);
  expect(ids(next)).toContain("Grace O.");
});

test("fill writes a value, and can be held to the blanks", () => {
  const blanks = fillColumn(doc(), "nodes", "Team", "Unassigned", true, null);
  expect(column(blanks.nodes, "Team")).toEqual([
    "Research",
    "Research",
    "Unassigned",
    "Unassigned",
  ]);
  const all = fillColumn(doc(), "nodes", "Team", "Unassigned", false, null);
  expect(new Set(column(all.nodes, "Team"))).toEqual(new Set(["Unassigned"]));
});

test("renaming a column carries into the mapping and its attributes", () => {
  const next = renameColumn(doc(), "edges", "Weight", "Meetings");
  expect(next.edges.columns.map((c) => c.name)).toEqual(["Source", "Target", "Meetings", "Kind"]);
  expect(next.mapping.attrs).toEqual(["Meetings", "Kind"]);
  expect(next.edges.rows[0].Meetings).toBe(3);
  expect("Weight" in next.edges.rows[0]).toBe(false);
});

test("renaming the id column follows it, and the graph still builds", () => {
  const next = renameColumn(doc(), "nodes", "Id", "Person");
  expect(next.nodeIdColumn).toBe("Person");
  expect(buildBaseGraph(next).nodes).toHaveLength(4);
});

test("renaming an endpoint column follows it into the mapping", () => {
  const next = renameColumn(doc(), "edges", "Source", "From");
  expect(next.mapping.source).toBe("From");
  expect(buildBaseGraph(next).links).toHaveLength(3);
});

test("a rename onto a name already taken changes nothing", () => {
  const before = doc();
  expect(renameColumn(before, "edges", "Weight", "Kind")).toBe(before);
});

test("deleting a column takes its values and its mention in the mapping", () => {
  const next = deleteColumn(doc(), "edges", "Weight");
  expect(next.edges.columns.map((c) => c.name)).toEqual(["Source", "Target", "Kind"]);
  expect(next.mapping.attrs).toEqual(["Kind"]);
  expect("Weight" in next.edges.rows[0]).toBe(false);
});

test("the columns holding the graph together refuse to be deleted", () => {
  const before = doc();
  expect(deleteColumn(before, "edges", "Source")).toBe(before);
  expect(deleteColumn(before, "nodes", "Id")).toBe(before);
});

test("reordering leaves names the order missed at the end", () => {
  const next = reorderColumns(doc(), "edges", ["Kind", "Source"]);
  expect(next.edges.columns.map((c) => c.name)).toEqual(["Kind", "Source", "Target", "Weight"]);
  expect(Object.keys(next.edges.rows[0])).toEqual(["Kind", "Source", "Target", "Weight"]);
});

test("a duplicate carries the values and takes a free name", () => {
  const next = duplicateColumn(doc(), "nodes", "Team");
  expect(next.nodes.columns.map((c) => c.name)).toEqual(["Id", "Team", "Team copy", "Note"]);
  expect(column(next.nodes, "Team copy")).toEqual(column(nodes, "Team"));
});

test("adding a column leaves it empty on every row", () => {
  const next = addColumn(doc(), "nodes", "Seniority", "number");
  expect(column(next.nodes, "Seniority")).toEqual([null, null, null, null]);
  expect(next.nodes.columns.at(-1)).toEqual({ name: "Seniority", type: "number" });
});

test("retyping re-reads the cells and says beforehand what it cannot read", () => {
  const before = doc();
  expect(retypeLosses(before.edges, "Kind", "number")).toBe(3);
  expect(retypeLosses(before.edges, "Weight", "text")).toBe(0);

  const next = retypeColumn(before, "edges", "Weight", "text");
  expect(column(next.edges, "Weight")).toEqual(["3", "1", "2"]);
});

test("style follows a renamed column and falls back off a deleted one", () => {
  const styled: GraphStyle = {
    ...DEFAULT_STYLE,
    nodeColor: "column:Team",
    edgeWidth: "cell:Weight",
  };
  const renamed = renameColumn(doc(), "nodes", "Team", "Group");
  expect(retargetStyle(styled, renamed, "Team", "Group").nodeColor).toBe("column:Group");

  const dropped = deleteColumn(doc(), "edges", "Weight");
  expect(retargetStyle(styled, dropped, "Weight", null).edgeWidth).toBe("uniform");
});

test("a node style token survives while either table still answers the name", () => {
  const styled: GraphStyle = { ...DEFAULT_STYLE, nodeColor: "column:Kind" };
  // Kind lives on the edges and projects onto the nodes; deleting the node
  // table's own column of that name, were there one, would not unstyle it.
  const withCopy = addColumn(doc(), "nodes", "Kind");
  const dropped = deleteColumn(withCopy, "nodes", "Kind");
  expect(retargetStyle(styled, dropped, "Kind", null).nodeColor).toBe("column:Kind");
});

test("the filter chain follows a rename and lets go of a deletion", () => {
  const chain: FilterStep[] = [
    {
      id: "a",
      enabled: true,
      kind: "column",
      table: "edges",
      column: "Kind",
      op: { kind: "values", selected: ["mentors"] },
    },
    {
      id: "b",
      enabled: true,
      kind: "column",
      table: "nodes",
      column: "Kind",
      op: { kind: "values", selected: ["x"] },
    },
    { id: "c", enabled: true, kind: "backbone", alpha: 0.3, weightColumn: "Weight" },
  ];
  const renamed = retargetChain(chain, "edges", "Kind", "Relation");
  expect(renamed.map((s) => (s.kind === "column" ? s.column : s.kind))).toEqual([
    "Relation",
    "Kind",
    "backbone",
  ]);

  const dropped = retargetChain(chain, "edges", "Weight", null);
  expect(dropped).toHaveLength(3);
  expect(dropped[2]).toMatchObject({ kind: "backbone", weightColumn: null });

  expect(retargetChain(chain, "edges", "Kind", null)).toHaveLength(2);
});
