/**
 * Parquet, read in the browser.
 *
 * hyparquet reads through an `AsyncBuffer`, so a dropped file is served by
 * `File.slice` and only the byte ranges a row group actually needs ever get
 * read. Two things have to become true before a parquet row can join the rest
 * of the app. Every value has to be a `CellValue`, because a bigint or a Date
 * loose in a row breaks the table, the filters and the JSON a workspace is
 * written as. And every column needs a type, which parquet already knows: it
 * is read off the schema rather than guessed from a sample, the way delimited
 * text has no choice but to guess.
 */
import type { AsyncBuffer, SchemaTree } from "hyparquet";
import type { CellValue, ColumnType, Dataset, Row } from "../types";
import { WORKING_SET_LIMIT } from "./source/limits";

export const PARQUET_EXTENSIONS = [".parquet", ".pq"];

/**
 * Every row here is held in memory and drawn, so a parquet file running to
 * millions of rows is read up to this many and the rest is reported rather
 * than quietly dropped.
 *
 * The same ceiling the whole working set has, since it is the same question:
 * how many edge rows the app can hold. It lives in `lib/source` now, because
 * that is also what decides whether a file is better opened through a query
 * engine than read into memory at all.
 */
export const PARQUET_ROW_LIMIT = WORKING_SET_LIMIT;

/** A `File` as something hyparquet can read byte ranges out of. */
function asyncBuffer(file: File): AsyncBuffer {
  return {
    byteLength: file.size,
    slice: (start, end) => file.slice(start, end).arrayBuffer(),
  };
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function base64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: one apply over a few hundred thousand arguments blows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Bigints and byte arrays have no JSON of their own; give them one. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return base64(value);
  return value;
}

/**
 * A parquet value as a cell. Parquet carries shapes a row cannot hold: INT64
 * arrives as a bigint, timestamps as a Date, lists and structs as objects.
 * Each lands as the nearest honest cell instead of being dropped, so nothing
 * in the file goes missing on the way to the table.
 */
export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return isFinite(value) ? value : null;
    case "bigint":
      // Past the safe range a number would round, and an id that rounds is an
      // id that collides with its neighbour, so it keeps its digits as text.
      return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  // Base64 rather than hex: `images.ts` already reads bare base64, so a column
  // of thumbnails works as a node image the moment it lands.
  if (value instanceof Uint8Array) return base64(value);
  try {
    return JSON.stringify(value, jsonSafe) ?? null;
  } catch {
    return null;
  }
}

/**
 * Logical and converted types whose values read as text however they were
 * stored. A timestamp is physically an INT64 and a UUID is physically sixteen
 * bytes, but neither is a quantity, and typing them as numbers would offer
 * them to filters and scales that have nothing useful to say about them.
 */
const TEXT_TYPES = new Set([
  "STRING",
  "ENUM",
  "UUID",
  "JSON",
  "BSON",
  "DATE",
  "TIME",
  "TIMESTAMP",
  "INTERVAL",
  "MAP",
  "LIST",
  "NULL",
  "VARIANT",
  "GEOMETRY",
  "GEOGRAPHY",
  // `converted_type` spells several of the same ideas differently.
  "UTF8",
  "TIME_MILLIS",
  "TIME_MICROS",
  "TIMESTAMP_MILLIS",
  "TIMESTAMP_MICROS",
  "MAP_KEY_VALUE",
]);

/**
 * The column type parquet declares. Unlike delimited text there is nothing to
 * infer: the file says what it holds, which is why a zero-padded id column
 * survives here and would not survive a sample-and-guess.
 */
export function columnType(field: SchemaTree): ColumnType {
  const { element, children } = field;
  // A group, a list or a map assembles into an object, and the only cell that
  // holds an object is the JSON text `toCell` writes for it.
  if (children.length > 0 || element.repetition_type === "REPEATED") return "text";

  const logical = element.logical_type?.type ?? element.converted_type;
  if (logical && TEXT_TYPES.has(logical)) return "text";
  if (logical === "DECIMAL") return "number";

  switch (element.type) {
    case "BOOLEAN":
      return "bool";
    case "INT32":
    case "INT64":
    case "FLOAT":
    case "DOUBLE":
      return "number";
    // INT96 was only ever a timestamp; byte arrays without a logical type are
    // bytes, and come out of `toCell` as base64.
    default:
      return "text";
  }
}

/**
 * Read a parquet file into the one table it holds. The reader and its
 * decompressors are imported lazily, so a session that never opens a parquet
 * file never pays for them.
 */
export async function parseParquet(file: File): Promise<Dataset> {
  const [{ parquetMetadataAsync, parquetReadObjects, parquetSchema }, { compressors }] =
    await Promise.all([import("hyparquet"), import("hyparquet-compressors")]);

  const buffer = asyncBuffer(file);
  const metadata = await parquetMetadataAsync(buffer);
  const fields = parquetSchema(metadata).children;

  if (fields.length < 2) {
    throw new Error(
      `"${file.name}" has ${fields.length === 1 ? "one column" : "no columns"}; an edge list needs at least two.`,
    );
  }
  const total = Number(metadata.num_rows);
  if (total === 0) throw new Error(`"${file.name}" has no rows.`);

  const raw = await parquetReadObjects({
    file: buffer,
    metadata,
    compressors,
    rowEnd: Math.min(total, PARQUET_ROW_LIMIT),
  });

  // Field order comes from the schema rather than from the first row's keys:
  // parquet declares an order, and a column that is null all the way down
  // still deserves its place in the table.
  const names = fields.map((f) => f.element.name);
  const rows: Row[] = raw.map((record) => {
    const row: Row = {};
    for (const name of names) row[name] = toCell(record[name]);
    return row;
  });

  return {
    fileName: file.name,
    tables: [
      {
        name: file.name.replace(/\.[^.]+$/, "") || "Parquet",
        columns: fields.map((f) => ({ name: f.element.name, type: columnType(f) })),
        rows,
      },
    ],
    truncated: rows.length < total ? { read: rows.length, total } : undefined,
  };
}
