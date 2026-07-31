import { expect, test } from "vitest";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parseParquet, toCell } from "./parquet";
import { parseFile } from "./parse";

type ColumnSource = Parameters<typeof parquetWriteBuffer>[0]["columnData"][number];

/** A parquet file in memory, handed over as the `File` an import would get. */
function parquetFile(name: string, columnData: ColumnSource[]): File {
  const buffer = parquetWriteBuffer({ columnData });
  return new File([buffer], name, { type: "application/octet-stream" });
}

const EDGES: ColumnSource[] = [
  { name: "source", data: ["ana", "ben", "cleo"], type: "STRING" },
  { name: "target", data: ["ben", "cleo", "ana"], type: "STRING" },
  { name: "weight", data: [3, 1, 4], type: "INT32" },
];

test("reads an edge list into a dataset", async () => {
  const dataset = await parseParquet(parquetFile("links.parquet", EDGES));

  expect(dataset.fileName).toBe("links.parquet");
  expect(dataset.tables).toHaveLength(1);
  expect(dataset.truncated).toBeUndefined();

  const table = dataset.tables[0];
  expect(table.name).toBe("links");
  expect(table.columns).toEqual([
    { name: "source", type: "text" },
    { name: "target", type: "text" },
    { name: "weight", type: "number" },
  ]);
  expect(table.rows).toEqual([
    { source: "ana", target: "ben", weight: 3 },
    { source: "ben", target: "cleo", weight: 1 },
    { source: "cleo", target: "ana", weight: 4 },
  ]);
});

test("column types come from the schema, not from a sample of the values", async () => {
  // Zero-padded ids read as numbers to anything that guesses from the text,
  // and a node id that loses its leading zeros collides with its neighbour.
  const dataset = await parseParquet(
    parquetFile("padded.parquet", [
      { name: "source", data: ["0071", "0071", "0042"], type: "STRING" },
      { name: "target", data: ["0042", "0500", "0500"], type: "STRING" },
    ]),
  );

  expect(dataset.tables[0].columns.map((c) => c.type)).toEqual(["text", "text"]);
  expect(dataset.tables[0].rows[0].source).toBe("0071");
});

test("a column that is null all the way down keeps its place and its type", async () => {
  const dataset = await parseParquet(
    parquetFile("sparse.parquet", [
      { name: "source", data: ["ana", "ben"], type: "STRING" },
      { name: "target", data: ["ben", "ana"], type: "STRING" },
      { name: "score", data: [null, null], type: "DOUBLE", nullable: true },
    ]),
  );

  expect(dataset.tables[0].columns[2]).toEqual({ name: "score", type: "number" });
  expect(dataset.tables[0].rows).toEqual([
    { source: "ana", target: "ben", score: null },
    { source: "ben", target: "ana", score: null },
  ]);
});

test("booleans and timestamps land as their own kinds of cell", async () => {
  const dataset = await parseParquet(
    parquetFile("typed.parquet", [
      { name: "source", data: ["ana", "ben"], type: "STRING" },
      { name: "target", data: ["ben", "ana"], type: "STRING" },
      { name: "active", data: [true, false], type: "BOOLEAN" },
      {
        name: "seen",
        data: [new Date("2024-03-01T00:00:00Z"), new Date("2024-03-02T12:30:00Z")],
        type: "TIMESTAMP",
      },
    ]),
  );

  const columns = dataset.tables[0].columns;
  expect(columns[2]).toEqual({ name: "active", type: "bool" });
  // A timestamp is physically an INT64, but it is not a quantity worth
  // scaling a node by, so it reads as text.
  expect(columns[3]).toEqual({ name: "seen", type: "text" });

  const rows = dataset.tables[0].rows;
  expect(rows[0].active).toBe(true);
  expect(rows[1].active).toBe(false);
  expect(rows[0].seen).toBe("2024-03-01T00:00:00.000Z");
});

test("a file with one column is refused, since an edge list needs two", async () => {
  await expect(
    parseParquet(parquetFile("thin.parquet", [{ name: "only", data: ["a"], type: "STRING" }])),
  ).rejects.toThrow(/at least two/);
});

test("parseFile routes a .parquet file to the parquet reader", async () => {
  const dataset = await parseFile(parquetFile("links.parquet", EDGES));
  expect(dataset.tables[0].rows).toHaveLength(3);
});

test("parseFile sniffs a parquet file that arrives without an extension", async () => {
  const dataset = await parseFile(parquetFile("part-00000", EDGES));
  expect(dataset.tables[0].columns.map((c) => c.name)).toEqual(["source", "target", "weight"]);
});

test("toCell keeps the digits of an integer too large to be a number", () => {
  expect(toCell(9007199254740993n)).toBe("9007199254740993");
  expect(toCell(-9007199254740993n)).toBe("-9007199254740993");
  expect(toCell(42n)).toBe(42);
});

test("toCell writes the shapes a row cannot hold as text", () => {
  expect(toCell(["a", "b"])).toBe('["a","b"]');
  expect(toCell({ kind: "team", size: 3n })).toBe('{"kind":"team","size":"3"}');
  expect(toCell(new Uint8Array([104, 105]))).toBe("aGk=");
  expect(toCell(new Date("2024-01-01T00:00:00Z"))).toBe("2024-01-01T00:00:00.000Z");
});

test("toCell drops values that are not really values", () => {
  expect(toCell(null)).toBe(null);
  expect(toCell(undefined)).toBe(null);
  expect(toCell(NaN)).toBe(null);
  expect(toCell(Infinity)).toBe(null);
  expect(toCell(new Date("nonsense"))).toBe(null);
});
