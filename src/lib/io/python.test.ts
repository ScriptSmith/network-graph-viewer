/**
 * The other end of the notebook widget.
 *
 * The Python package writes a workspace and this reads it. Neither side can
 * see the other, so both are pinned to one committed fixture: Python asserts
 * it still builds that file, and this asserts the app can still open it. A
 * change to either end that the other has not heard about fails here.
 */
import { expect, test } from "vitest";
import text from "../../../python/tests/fixtures/workspace.json?raw";
import { parseWorkspace } from "./ngv";
import { applyStyle, buildBaseGraph } from "../graph";

test("a workspace written by the Python package opens as a document", () => {
  const { doc } = parseWorkspace(text, "fallback");

  expect(doc.name).toBe("Team");
  expect(doc.nodeIdColumn).toBe("Id");
  expect(doc.nodesDeclared).toBe(false);
  expect(doc.mapping).toEqual({ source: "from", target: "to", attrs: ["weight", "team"] });
  expect(doc.edges.columns.map((c) => c.type)).toEqual(["text", "text", "number", "text"]);
  expect(doc.nodes.rows.map((r) => r.Id)).toEqual(["ana", "ben", "cleo"]);
});

test("and draws the graph it describes, styled the way it asked", () => {
  const { doc, workspace } = parseWorkspace(text, "fallback");
  const graph = applyStyle(buildBaseGraph(doc), doc, workspace.style);

  expect(graph.nodes.map((n) => n.id).sort()).toEqual(["ana", "ben", "cleo"]);
  expect(graph.links).toHaveLength(3);

  // `color="team"` on the Python side is a `column:` token here, and the
  // column lives on the edges, so it reaches the nodes by projection.
  expect(workspace.style.nodeColor).toBe("column:team");
  expect(graph.groups).toEqual(["design", "research"]);
  expect(new Map(graph.nodes.map((n) => [n.id, n.group])).get("ben")).toBe("design");
});

test("the fixture carries nothing a cell cannot hold", () => {
  const { doc } = parseWorkspace(text, "fallback");
  for (const table of [doc.edges, doc.nodes]) {
    for (const row of table.rows) {
      for (const value of Object.values(row)) {
        expect(["string", "number", "boolean"]).toContain(value === null ? "string" : typeof value);
      }
    }
  }
});
