import type { CellValue, Dataset, GraphStyle, Mapping, Row, Sheet } from "../types";
import { DEFAULT_STYLE } from "../types";

export const ACCEPTED_EXTENSIONS = [".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls", ".ods"];

/**
 * Parse an Excel or CSV file into plain row objects, entirely in memory.
 * SheetJS handles both formats through the same reader; it is imported
 * lazily so the initial bundle stays small.
 */
export async function parseFile(file: File): Promise<Dataset> {
  const { read, utils } = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = read(buffer, { type: "array" });

  const sheets: Sheet[] = [];
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name];
    if (!ws) continue;
    const rows = utils.sheet_to_json<Row>(ws, { defval: null });
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    if (columns.length < 2) continue;
    sheets.push({ name, columns, rows });
  }

  if (sheets.length === 0) {
    throw new Error(
      `No usable table in "${file.name}". A sheet needs a header row and at least two columns.`,
    );
  }
  return { fileName: file.name, sheets };
}

/**
 * Parse text pasted from a spreadsheet into the same Dataset shape as an
 * uploaded file. Excel and Google Sheets put copied cells on the clipboard
 * as tab-separated text; SheetJS guesses the delimiter, so pasted CSV works
 * too.
 */
export async function parsePastedText(text: string): Promise<Dataset> {
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
  const columns = Array.from({ length: width }, (_, i) => {
    const name = hasHeader ? first[i] : null;
    return typeof name === "string" ? name.trim() : `Column ${utils.encode_col(i)}`;
  });

  const rows: Row[] = [];
  for (const cells of hasHeader ? grid.slice(1) : grid) {
    if (cells.every((v) => v === null || v === "")) continue;
    const row: Row = {};
    columns.forEach((c, i) => {
      row[c] = cells[i] ?? null;
    });
    rows.push(row);
  }

  if (width < 2 || rows.length === 0) {
    throw new Error("Pasted cells need at least two columns (source and target) and one data row.");
  }
  return { fileName: "Pasted data", sheets: [{ name: "Pasted", columns, rows }] };
}

/** True when at least 80% of the column's non-empty values parse as numbers. */
export function isNumericColumn(rows: Row[], column: string): boolean {
  let seen = 0;
  let numeric = 0;
  for (const row of rows.slice(0, 200)) {
    const v = row[column];
    if (v === null || v === "") continue;
    seen++;
    if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))) {
      numeric++;
    }
  }
  return seen > 0 && numeric / seen >= 0.8;
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
export function guessMapping(sheet: Sheet): Mapping {
  const cols = sheet.columns;
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
export function guessStyle(sheet: Sheet, mapping: Mapping): GraphStyle {
  const candidate = sheet.columns.find(
    (c) =>
      c !== mapping.source &&
      c !== mapping.target &&
      GROUP_HINTS.test(c) &&
      !isNumericColumn(sheet.rows, c),
  );
  return { ...DEFAULT_STYLE, nodeColor: candidate ? `column:${candidate}` : "none" };
}
