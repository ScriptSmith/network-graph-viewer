import { expect, test } from "vitest";
import type { Dataset, Table } from "../../types";
import type { DataSource, EdgeSelection } from "./types";

/**
 * The contract every `DataSource` has to satisfy, written once.
 *
 * This file is the actual specification of what a source means. Prose in an
 * interface says what the methods are called; this says what the answers are,
 * which is the part two implementations can quietly disagree about. A native
 * pass over rows and a SQL engine's semi-joins have to come back with the same
 * neighbourhood or the app is two apps.
 *
 * Under vitest it runs against the native source only: the engine starts
 * inside a browser and cannot be spun up here. The engine is held to the same
 * answers by the SQL tests, which pin the statements it would run, and by
 * headed browser sessions; a divergence between the two implementations is a
 * bug in whichever one the chain's own semantics disagree with.
 */

/** The fixture: a small directed graph with a type column and a weight. */
export const FIXTURE: Table = {
  name: "Edges",
  columns: [
    { name: "src", type: "text" },
    { name: "dst", type: "text" },
    { name: "line", type: "text" },
    { name: "w", type: "number" },
  ],
  rows: [
    { src: "a", dst: "b", line: "rail", w: 1 },
    { src: "a", dst: "c", line: "bus", w: 2 },
    { src: "b", dst: "c", line: "rail", w: 3 },
    { src: "c", dst: "d", line: "rail", w: 4 },
    { src: "d", dst: "e", line: "bus", w: 5 },
    { src: "x", dst: "y", line: "rail", w: 6 },
  ],
};

export const FIXTURE_DATASET: Dataset = { fileName: "fixture", tables: [FIXTURE] };

const ENDS = { table: "Edges", source: "src", target: "dst" };

export const selection = (over: Partial<EdgeSelection> = {}): EdgeSelection => ({
  ...ENDS,
  seeds: [],
  depth: 1,
  direction: "any",
  edgeLimit: 1000,
  ...over,
});

/** Node ids of a materialized selection, sorted so order is not the subject. */
async function nodesOf(source: DataSource, over: Partial<EdgeSelection> = {}): Promise<string[]> {
  const { doc } = await source.materialize(selection(over));
  return doc.nodes.rows.map((r) => String(r[doc.nodeIdColumn])).sort();
}

async function edgeCount(source: DataSource, over: Partial<EdgeSelection> = {}): Promise<number> {
  const { doc } = await source.materialize(selection(over));
  return doc.edges.rows.length;
}

/**
 * Run the suite. `make` returns a fresh source over `FIXTURE_DATASET`; it is
 * async so an engine can be started up per test.
 */
export function runContract(name: string, make: () => Promise<DataSource>): void {
  const withSource = async (body: (source: DataSource) => Promise<void>) => {
    const source = await make();
    try {
      await body(source);
    } finally {
      source.dispose();
    }
  };

  test(`${name}: the schema names the tables and counts their rows exactly`, async () => {
    await withSource(async (source) => {
      const schema = await source.schema();
      const table = schema.tables.find((t) => t.name === "Edges");
      expect(table?.rowCount).toBe(6);
      expect(table?.columns.map((c) => c.name)).toEqual(["src", "dst", "line", "w"]);
      expect(table?.columns.find((c) => c.name === "w")?.type).toBe("number");
    });
  });

  test(`${name}: distinct values come back with their counts, most frequent first`, async () => {
    await withSource(async (source) => {
      const values = await source.distinct("Edges", "line", 10);
      expect(values.map((v) => [String(v.value), v.count])).toEqual([
        ["rail", 4],
        ["bus", 2],
      ]);
      expect(await source.distinct("Edges", "line", 1)).toHaveLength(1);
    });
  });

  test(`${name}: a numeric column reports its range, a text column reports none`, async () => {
    await withSource(async (source) => {
      expect(await source.range("Edges", "w")).toEqual({ min: 1, max: 6 });
      expect(await source.range("Edges", "line")).toBeNull();
    });
  });

  test(`${name}: node counts cover both endpoint columns`, async () => {
    await withSource(async (source) => {
      const count = await source.nodeCount(ENDS);
      // a b c d e x y. An estimate is allowed to be close rather than right.
      if (count.approximate) expect(Math.abs(count.value - 7)).toBeLessThanOrEqual(2);
      else expect(count.value).toBe(7);
    });
  });

  test(`${name}: searching finds nodes from either endpoint column`, async () => {
    await withSource(async (source) => {
      expect((await source.searchNodes(ENDS, "y", 10)).map((h) => h.id)).toEqual(["y"]);
      expect(await source.searchNodes(ENDS, "", 10)).toEqual([]);
      expect((await source.searchNodes(ENDS, "a", 10)).map((h) => h.id)).toEqual(["a"]);
    });
  });

  test(`${name}: a pasted list is validated by point lookup, kept in its own order`, async () => {
    await withSource(async (source) => {
      expect(await source.lookupIds(ENDS, ["x", "nobody", "a", "x"])).toEqual(["x", "a"]);
      expect(await source.lookupIds(ENDS, [])).toEqual([]);
    });
  });

  test(`${name}: depth 0 is the seeds alone`, async () => {
    await withSource(async (source) => {
      expect(await nodesOf(source, { seeds: ["a"], depth: 0 })).toEqual(["a"]);
      expect(await edgeCount(source, { seeds: ["a"], depth: 0 })).toBe(0);
    });
  });

  test(`${name}: one hop reaches the neighbours and the edges among them`, async () => {
    await withSource(async (source) => {
      expect(await nodesOf(source, { seeds: ["a"], depth: 1 })).toEqual(["a", "b", "c"]);
      // a-b, a-c and the b-c edge between two reached nodes: a neighbourhood
      // is the induced subgraph, not the spanning tree that found it.
      expect(await edgeCount(source, { seeds: ["a"], depth: 1 })).toBe(3);
    });
  });

  test(`${name}: walkedOnly keeps the steps taken rather than the region`, async () => {
    await withSource(async (source) => {
      expect(await nodesOf(source, { seeds: ["a"], depth: 1, walkedOnly: true })).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(await edgeCount(source, { seeds: ["a"], depth: 1, walkedOnly: true })).toBe(2);
    });
  });

  test(`${name}: direction follows the arrows`, async () => {
    await withSource(async (source) => {
      expect(await nodesOf(source, { seeds: ["c"], depth: 1, direction: "out" })).toEqual([
        "c",
        "d",
      ]);
      expect(await nodesOf(source, { seeds: ["c"], depth: 1, direction: "in" })).toEqual([
        "a",
        "b",
        "c",
      ]);
    });
  });

  test(`${name}: the walk constraint restricts which edges are followed`, async () => {
    await withSource(async (source) => {
      // a-b, b-c and c-d are rail; a-c is bus. So rail-only, d is three hops
      // from a rather than the two it takes when any edge may be walked.
      const rail = { column: "line", values: ["rail"] };
      expect(await nodesOf(source, { seeds: ["a"], depth: 2, where: rail })).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(await nodesOf(source, { seeds: ["a"], depth: 3, where: rail })).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
      // An empty exclusion is no constraint, so "e" comes back too.
      const none = { column: "line", excluded: [] };
      expect(await nodesOf(source, { seeds: ["a"], depth: 3, where: none })).toEqual([
        "a",
        "b",
        "c",
        "d",
        "e",
      ]);
    });
  });

  test(`${name}: the constraint governs the walk, not the neighbourhood it found`, async () => {
    await withSource(async (source) => {
      // Rail from "a" at depth 2 reaches b and c along a-b and b-c. The a-c
      // edge is a bus edge between two reached nodes: with walkedOnly off it
      // comes back, because the region includes it; the constraint only said
      // which edges the walk could step along. walkedOnly is the switch that
      // narrows the answer to the steps themselves.
      const rail = { column: "line", values: ["rail"] };
      expect(await edgeCount(source, { seeds: ["a"], depth: 2, where: rail })).toBe(3);
      expect(
        await edgeCount(source, { seeds: ["a"], depth: 2, where: rail, walkedOnly: true }),
      ).toBe(2);
    });
  });

  test(`${name}: predicates are pushed down and drop rows before the walk`, async () => {
    await withSource(async (source) => {
      const heavy = [{ column: "w", op: { kind: "range" as const, min: 3, max: null } }];
      // a's edges weigh 1 and 2, so nothing is walkable from it at all.
      expect(await nodesOf(source, { seeds: ["a"], depth: 2, predicates: heavy })).toEqual(["a"]);
      expect(await nodesOf(source, { seeds: ["c"], depth: 1, predicates: heavy })).toEqual([
        "b",
        "c",
        "d",
      ]);
    });
  });

  test(`${name}: a disconnected component is not reached`, async () => {
    await withSource(async (source) => {
      expect(await nodesOf(source, { seeds: ["a"], depth: 9 })).toEqual(["a", "b", "c", "d", "e"]);
    });
  });

  test(`${name}: no seeds takes the source from the top`, async () => {
    await withSource(async (source) => {
      expect(await edgeCount(source, { seeds: [], edgeLimit: 1000 })).toBe(6);
      expect(await edgeCount(source, { seeds: [], edgeLimit: 2 })).toBe(2);
    });
  });

  test(`${name}: the budget clips the result and says so`, async () => {
    await withSource(async (source) => {
      const result = await source.materialize(selection({ seeds: [], edgeLimit: 3 }));
      expect(result.doc.edges.rows).toHaveLength(3);
      expect(result.truncated).toEqual({ read: 3, total: 6 });

      const whole = await source.materialize(selection({ seeds: [], edgeLimit: 100 }));
      expect(whole.truncated).toBeUndefined();
    });
  });

  test(`${name}: counting agrees with materializing`, async () => {
    await withSource(async (source) => {
      for (const over of [
        { seeds: ["a"], depth: 1 },
        { seeds: ["a"], depth: 2 },
        { seeds: ["a"], depth: 2, walkedOnly: true },
        { seeds: ["c"], depth: 1, direction: "out" as const },
        // Constrained walks, where the induced answer and the walked answer
        // part ways, and unseeded reads, constrained and not: the counts must
        // describe exactly the graph Load would bring in, in every mode.
        { seeds: ["a"], depth: 2, where: { column: "line", values: ["rail"] } },
        {
          seeds: ["a"],
          depth: 2,
          where: { column: "line", values: ["rail"] },
          walkedOnly: true as const,
        },
        { seeds: [] as string[] },
        { seeds: [] as string[], where: { column: "line", excluded: ["bus"] } },
        {
          seeds: [] as string[],
          predicates: [{ column: "w", op: { kind: "range" as const, min: 3, max: null } }],
        },
        { seeds: [] as string[], edgeLimit: 2 },
      ]) {
        const counts = await source.neighborhood(selection(over));
        const result = await source.materialize(selection(over));
        expect(counts.nodes).toBe(result.doc.nodes.rows.length);
        expect(counts.edges).toBe(result.doc.edges.rows.length);
        expect(counts.truncated).toBe(result.truncated !== undefined);
      }
    });
  });

  test(`${name}: hops report what arrived at each depth`, async () => {
    await withSource(async (source) => {
      const counts = await source.neighborhood(selection({ seeds: ["a"], depth: 2 }));
      expect(counts.hops.map((h) => [h.depth, h.nodes])).toEqual([
        [0, 1],
        [1, 2],
        [2, 1],
      ]);
    });
  });

  test(`${name}: the materialized document is an ordinary one`, async () => {
    await withSource(async (source) => {
      const { doc } = await source.materialize(selection({ seeds: ["a"], depth: 1 }));
      expect(doc.mapping.source).toBe("src");
      expect(doc.mapping.target).toBe("dst");
      // Every column the source table had, so the working set can be styled
      // and filtered on anything the file carried.
      expect(doc.edges.columns.map((c) => c.name)).toEqual(["src", "dst", "line", "w"]);
      expect(doc.edges.rows.every((r) => typeof r.w === "number")).toBe(true);
    });
  });
}
