import type { CellValue, Column, Dataset, GraphStyle, Mapping, Row, Table } from "../types";
import { DEFAULT_STYLE } from "../types";
import { PARQUET_EXTENSIONS, parseParquet } from "./parquet";

export const SHEET_EXTENSIONS = [".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls", ".ods"];

export const ACCEPTED_EXTENSIONS = [...SHEET_EXTENSIONS, ...PARQUET_EXTENSIONS];

/**
 * A reader for files that arrive as bytes rather than text. Text-shaped
 * sources are `parseText`'s half of the split, sniffed from their opening
 * characters; these are told apart by name, or by the few leading bytes a
 * binary format stamps itself with when the name says nothing.
 */
interface FileParser {
  extensions: string[];
  /** True when the file's first bytes identify the format on their own. */
  magic?: (head: Uint8Array) => boolean;
  parse: (file: File) => Promise<Dataset>;
}

/** Enough for any signature below, and one slice however many readers there are. */
const HEAD_BYTES = 8;

const FILE_PARSERS: FileParser[] = [
  {
    extensions: PARQUET_EXTENSIONS,
    // Parquet opens and closes with "PAR1", so an unlabelled one is still
    // recognisable, which is common for files pulled out of a data lake.
    magic: (head) => head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31,
    parse: parseParquet,
  },
  { extensions: SHEET_EXTENSIONS, parse: parseSheet },
];

/**
 * Read a file into rows. The format comes from the extension where there is
 * one, and from the leading bytes where there is not. SheetJS is the fallback
 * rather than an error, because it reads more formats than it is listed for
 * and a mislabelled spreadsheet is a likelier arrival than a file nothing here
 * can open at all.
 */
export async function parseFile(file: File): Promise<Dataset> {
  const lowered = file.name.toLowerCase();
  const named = FILE_PARSERS.find((p) => p.extensions.some((ext) => lowered.endsWith(ext)));
  if (named) return named.parse(file);

  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const sniffed = FILE_PARSERS.find((p) => p.magic?.(head));
  return (sniffed ?? { parse: parseSheet }).parse(file);
}

/**
 * Parse an Excel or CSV file into plain row objects, entirely in memory.
 * SheetJS handles both formats through the same reader; it is imported
 * lazily so the initial bundle stays small.
 */
async function parseSheet(file: File): Promise<Dataset> {
  const { read, utils } = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = read(buffer, { type: "array" });

  const tables: Table[] = [];
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name];
    if (!ws) continue;
    const rows = utils.sheet_to_json<Row>(ws, { defval: null });
    if (rows.length === 0) continue;
    const names = Object.keys(rows[0]);
    if (names.length < 2) continue;
    tables.push({ name, columns: inferColumns(rows, names), rows });
  }

  if (tables.length === 0) {
    throw new Error(
      `No usable table in "${file.name}". A sheet needs a header row and at least two columns.`,
    );
  }
  return { fileName: file.name, tables };
}

/**
 * Parse text pasted from a spreadsheet into the same Dataset shape as an
 * uploaded file. Excel and Google Sheets put copied cells on the clipboard
 * as tab-separated text; SheetJS guesses the delimiter, so pasted CSV works
 * too.
 */
export async function parsePastedText(text: string, name = "Pasted data"): Promise<Dataset> {
  const { read, utils } = await import("xlsx");
  const workbook = read(text.replace(/[\r\n]+$/, ""), { type: "string" });
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const grid = ws ? utils.sheet_to_json<CellValue[]>(ws, { header: 1, defval: null }) : [];

  // Copied ranges often lack a header row. Real headers are distinct
  // non-empty strings, so anything else means the first row is data and
  // column names get synthesized instead of swallowing an edge.
  const first = grid[0] ?? [];
  const hasHeader =
    first.length > 0 &&
    first.every((v) => typeof v === "string" && v.trim() !== "") &&
    new Set(first).size === first.length;

  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const names = Array.from({ length: width }, (_, i) => {
    const header = hasHeader ? first[i] : null;
    return typeof header === "string" ? header.trim() : `Column ${utils.encode_col(i)}`;
  });

  const rows: Row[] = [];
  for (const cells of hasHeader ? grid.slice(1) : grid) {
    if (cells.every((v) => v === null || v === "")) continue;
    const row: Row = {};
    names.forEach((c, i) => {
      row[c] = cells[i] ?? null;
    });
    rows.push(row);
  }

  if (width < 2 || rows.length === 0) {
    throw new Error("Pasted cells need at least two columns (source and target) and one data row.");
  }
  return {
    fileName: name,
    tables: [{ name: "Pasted", columns: inferColumns(rows, names), rows }],
  };
}

const BOOLEAN_WORDS = new Set(["true", "false", "yes", "no"]);

/**
 * Classify each column once, at import. Everything downstream (filters, the
 * datatable, GEXF and GraphML attribute types) reads the result instead of
 * re-scanning the rows.
 */
export function inferColumns(rows: Row[], names: string[]): Column[] {
  return names.map((name) => ({ name, type: inferColumnType(rows, name) }));
}

function inferColumnType(rows: Row[], column: string): Column["type"] {
  let seen = 0;
  let numeric = 0;
  let boolean = 0;
  for (const row of rows.slice(0, 200)) {
    const v = row[column];
    if (v === null || v === "") continue;
    seen++;
    if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))) {
      numeric++;
    }
    if (typeof v === "boolean" || (typeof v === "string" && BOOLEAN_WORDS.has(v.toLowerCase()))) {
      boolean++;
    }
  }
  if (seen === 0) return "text";
  if (boolean === seen) return "bool";
  return numeric / seen >= 0.8 ? "number" : "text";
}

/** True when at least 80% of the column's non-empty values parse as numbers. */
export function isNumericColumn(rows: Row[], column: string): boolean {
  return inferColumnType(rows, column) === "number";
}

export function asNumber(v: CellValue): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

const SOURCE_HINTS = /^(source|from|supervisor|manager|parent|origin|start|head)$/i;
const TARGET_HINTS = /^(target|to|supervisee|report|child|destination|end|employee)$/i;
const SOURCE_SOFT = /source|from|supervisor|manager|parent/i;
const TARGET_SOFT = /target|supervisee|report|child|dest/i;
const GROUP_HINTS = /group|department|dept|team|type|category|role|org|unit/i;

/** Guess the structural columns from the header names. */
export function guessMapping(table: Table): Mapping {
  const cols = table.columns.map((c) => c.name);
  const find = (re: RegExp, taken: string[]) => cols.find((c) => re.test(c) && !taken.includes(c));

  let source = find(SOURCE_HINTS, []) ?? find(SOURCE_SOFT, []);
  let target = source ? (find(TARGET_HINTS, [source]) ?? find(TARGET_SOFT, [source])) : undefined;
  if (!source || !target) {
    source = cols[0];
    target = cols.find((c) => c !== source) ?? cols[0];
  }

  const attrs = cols.filter((c) => c !== source && c !== target);
  return { source, target, attrs };
}

/** Guess appearance defaults: color nodes by a group-like column if present. */
export function guessStyle(table: Table, mapping: Mapping): GraphStyle {
  const candidate = table.columns.find(
    (c) =>
      c.name !== mapping.source &&
      c.name !== mapping.target &&
      c.type === "text" &&
      GROUP_HINTS.test(c.name),
  );
  return { ...DEFAULT_STYLE, nodeColor: candidate ? `column:${candidate.name}` : "none" };
}
