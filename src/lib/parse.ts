import type { CellValue, Dataset, Row, Sheet } from "../types";

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

/** Guess a sensible column mapping from the header names. */
export function guessMapping(sheet: Sheet): {
  source: string;
  target: string;
  attrs: string[];
  weight: null;
  color: string | null;
} {
  const cols = sheet.columns;
  const find = (re: RegExp, taken: string[]) => cols.find((c) => re.test(c) && !taken.includes(c));

  let source = find(SOURCE_HINTS, []) ?? find(SOURCE_SOFT, []);
  let target = source ? (find(TARGET_HINTS, [source]) ?? find(TARGET_SOFT, [source])) : undefined;
  if (!source || !target) {
    source = cols[0];
    target = cols.find((c) => c !== source) ?? cols[0];
  }

  const color = find(GROUP_HINTS, [source, target]) ?? null;
  const attrs = cols.filter((c) => c !== source && c !== target);
  return { source, target, attrs, weight: null, color };
}
