import type {
  CellValue,
  Column,
  ColumnType,
  Dataset,
  GraphDoc,
  GraphStyle,
  Row,
  Table,
} from "../../types";
import { cellToId } from "../cells";
import { buildDoc, DEFAULT_NODE_ID_COLUMN, reconcileNodes } from "../doc";
import { guessMapping, inferColumnRole } from "../parse";
import type { ImportedGraph } from "./types";
import { tableFrom } from "./xml";

/**
 * JSON, in the two shapes a network arrives in.
 *
 * A file can be a table: an array of records, or one record per line, which is
 * what a database export or a log looks like and is read here the way a CSV is.
 * Or it can be node-link, the shape d3 and NetworkX write, where an object
 * carries a `nodes` array beside a `links` one; that is the document's two
 * tables already, so node attributes arrive as node attributes instead of being
 * projected off the edges. An object holding neither is read as a workbook, one
 * table per array of records in it, since that is what a sheet is.
 *
 * Unlike delimited text there is nothing to guess about a value: JSON states
 * whether it is a number, a string or a boolean, so a zero-padded id written as
 * a string stays text here the way it does coming out of parquet. Anything
 * deeper than a scalar becomes its own JSON text, because a cell holds one
 * value and dropping the rest would lose what the file said.
 */

export const JSON_EXTENSIONS = [".json", ".jsonl", ".ndjson"];

/** What the `nodes` array is paired with, under the names writers use for it. */
const LINK_KEYS = ["links", "edges"];

/** Keys that name a node, in the order they are believed. */
const ID_KEYS = ["id", "name", "key", "label", "node"];

/** Text that opens the way JSON opens, once the other formats are ruled out. */
export function looksLikeJson(head: string): boolean {
  // `\s` covers the byte order mark as well as the spaces a writer indents with.
  return /^\s*[[{]/.test(head);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A JSON value as a cell, which is the same value unless it is deeper than one. */
function jsonCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return isFinite(value) ? value : null;
  }
  return JSON.stringify(value) ?? null;
}

/** Every key any record uses, in the order the file first uses it. */
function namesOf(records: Record<string, unknown>[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

function rowOf(record: Record<string, unknown>, names: string[]): Row {
  const row: Row = {};
  for (const name of names) row[name] = jsonCell(record[name]);
  return row;
}

/**
 * The type the file stated. Every value carries its own type in JSON, so this
 * counts what is there rather than sampling and guessing: a column of strings
 * is text however numeric those strings look, and a column that mixes shapes is
 * text because that is the only cell all of them fit in.
 */
function declaredType(rows: Row[], name: string): ColumnType {
  let seen = 0;
  let numbers = 0;
  let booleans = 0;
  for (const row of rows) {
    const value = row[name];
    if (value === null) continue;
    seen++;
    if (typeof value === "number") numbers++;
    else if (typeof value === "boolean") booleans++;
  }
  if (seen === 0) return "text";
  if (numbers === seen) return "number";
  if (booleans === seen) return "bool";
  return "text";
}

/** Types the file settled, roles still inferred: what a value is *for* is a guess either way. */
function columnsOf(rows: Row[], names: string[]): Column[] {
  return names.map((name) => {
    const type = declaredType(rows, name);
    const role = inferColumnRole(rows, name, type);
    return role === undefined ? { name, type } : { name, type, role };
  });
}

const tableOf = (name: string, rows: Row[], names: string[]): Table =>
  tableFrom(name, columnsOf(rows, names), rows);

/**
 * The line-delimited form: one JSON value per line, which is not a JSON
 * document and so is only reached once the document parse has failed. A line
 * that fails after others have parsed names itself; a first line that fails
 * means this was never line-delimited, and the document's own complaint is the
 * one worth repeating.
 */
function readLines(body: string, name: string, whole: unknown): unknown[] {
  const values: unknown[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    try {
      values.push(JSON.parse(lines[i]));
    } catch {
      if (values.length === 0) {
        const said = whole instanceof Error ? whole.message : "it could not be read";
        throw new Error(`"${name}" is not valid JSON: ${said}`);
      }
      throw new Error(`Line ${i + 1} of "${name}" is not valid JSON.`);
    }
  }
  if (values.length === 0) throw new Error(`"${name}" is empty.`);
  return values;
}

function readJson(text: string, name: string): unknown {
  // A byte order mark is whitespace to a person and a syntax error to JSON.parse.
  const body = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(body);
  } catch (error) {
    return readLines(body, name, error);
  }
}

/** One table per named array, skipping the arrays that hold no usable rows. */
function tablesFrom(arrays: [string, unknown[]][]): Table[] {
  const tables: Table[] = [];
  for (const [key, entries] of arrays) {
    const records = entries.filter(isRecord);
    if (records.length === 0) continue;
    const names = namesOf(records);
    // Two fields is the same floor a sheet has: an edge needs both its ends.
    if (names.length < 2) continue;
    tables.push(
      tableOf(
        key,
        records.map((record) => rowOf(record, names)),
        names,
      ),
    );
  }
  return tables;
}

/**
 * The tabular reading: an array of records is one table, and an object is a
 * workbook, one table per array of records it holds, so a file carrying an edge
 * list beside a lookup opens with both to choose between. An object that yields
 * no table that way is one record itself, which is what a file holding a single
 * row looks like, and what a line-delimited file with one line in it parses as.
 */
function toDataset(value: unknown, name: string): Dataset {
  const stem = name.replace(/\.[^.]+$/, "");
  const table = stem === "" ? "Records" : stem;
  const arrays: [string, unknown[]][] = Array.isArray(value)
    ? [[table, value]]
    : isRecord(value)
      ? Object.entries(value).filter((e): e is [string, unknown[]] => Array.isArray(e[1]))
      : [];

  let tables = tablesFrom(arrays);
  if (tables.length === 0 && isRecord(value)) tables = tablesFrom([[table, [value]]]);

  if (tables.length === 0) {
    throw new Error(
      `No usable table in "${name}". A JSON graph is an array of objects with at ` +
        `least two fields each, one object per line, or an object with "nodes" and "links" arrays.`,
    );
  }
  return { fileName: name, tables };
}

interface NodeLink {
  nodes: unknown[];
  links: unknown[];
  /** Only an explicit `"directed": false` means undirected; silence means arrows. */
  directed: boolean;
}

function nodeLinkOf(value: unknown): NodeLink | null {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return null;
  const key = LINK_KEYS.find((k) => Array.isArray(value[k]));
  if (key === undefined) return null;
  return { nodes: value.nodes, links: value[key] as unknown[], directed: value.directed !== false };
}

function fromNodeLink(source: NodeLink, name: string): ImportedGraph {
  const records = source.nodes.filter(isRecord);
  const nodeNames = namesOf(records);
  const idColumn =
    ID_KEYS.map((key) => nodeNames.find((n) => n.toLowerCase() === key)).find(
      (n) => n !== undefined,
    ) ??
    nodeNames[0] ??
    DEFAULT_NODE_ID_COLUMN;
  const nodeColumns = [idColumn, ...nodeNames.filter((n) => n !== idColumn)];
  // A node can be written as the bare id rather than as a record of one field.
  const nodeRows: Row[] = source.nodes.map((entry) =>
    isRecord(entry) ? rowOf(entry, nodeNames) : { [idColumn]: jsonCell(entry) },
  );

  const declared = new Set<string>();
  for (const row of nodeRows) {
    const id = cellToId(row[idColumn]);
    if (id !== null) declared.add(id);
  }

  const linkRecords = source.links.filter(isRecord);
  const linkNames = namesOf(linkRecords);
  // `source` and `target` is the convention, and the same header hints that read
  // a CSV read anything else. Below two fields there is nothing to find, and an
  // endpoint column has to exist either way for the edges to have ends.
  const mapping =
    linkNames.length >= 2
      ? guessMapping({
          name: "Edges",
          columns: linkNames.map((n) => ({ name: n, type: "text" as const })),
          rows: [],
        })
      : { source: "Source", target: "Target", attrs: [] };

  // Node-link files predating d3 v4 index into the nodes array instead of
  // naming ids. Read that way only when every endpoint is an index and none of
  // them is a declared id, so a graph whose nodes really are numbered 0, 1, 2
  // keeps its own numbering.
  const ends = linkRecords.flatMap((r) => [r[mapping.source], r[mapping.target]]);
  const byIndex =
    ends.length > 0 &&
    ends.every(
      (v) =>
        typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 0 &&
        v < nodeRows.length &&
        !declared.has(String(v)),
    );

  const endpoint = (raw: unknown): CellValue => {
    // A simulation replaces an endpoint with the node it resolved to, so a graph
    // serialized after d3 has run carries the whole node record here.
    if (isRecord(raw)) return raw[idColumn] === undefined ? jsonCell(raw) : jsonCell(raw[idColumn]);
    if (byIndex && typeof raw === "number") return nodeRows[raw][idColumn];
    return jsonCell(raw);
  };

  const edgeColumns = [
    mapping.source,
    mapping.target,
    ...linkNames.filter((n) => n !== mapping.source && n !== mapping.target),
  ];
  const edgeRows: Row[] = linkRecords.map((record) => ({
    ...rowOf(record, linkNames),
    [mapping.source]: endpoint(record[mapping.source]),
    [mapping.target]: endpoint(record[mapping.target]),
  }));

  const doc: GraphDoc = {
    name,
    nodes: tableOf("Nodes", nodeRows, nodeColumns),
    edges: tableOf("Edges", edgeRows, edgeColumns),
    nodeIdColumn: idColumn,
    mapping: { source: mapping.source, target: mapping.target, attrs: edgeColumns.slice(2) },
    nodesDeclared: true,
  };
  // An arrowhead on an undirected edge says something the file did not.
  const stated: Partial<GraphStyle> | undefined = source.directed ? undefined : { arrows: false };
  // An edge may name a node the nodes array left out; it still exists.
  return { doc: reconcileNodes(doc), style: stated };
}

/**
 * Read JSON or line-delimited JSON. Node-link comes back as a document, the way
 * the graph formats do, since the file has already said which table is which;
 * anything tabular comes back as a dataset as well, so its columns are picked
 * the way a spreadsheet's are.
 */
export function parseJson(text: string, name: string): ImportedGraph & { dataset?: Dataset } {
  const value = readJson(text, name);
  const link = nodeLinkOf(value);
  if (link !== null) return fromNodeLink(link, name);

  const dataset = toDataset(value, name);
  return { doc: buildDoc(name, dataset.tables[0]), dataset };
}
