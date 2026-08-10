import { parquetMetadataAsync } from "hyparquet";
import { PARQUET_EXTENSIONS } from "../parquet";
import { WORKING_SET_LIMIT } from "./limits";
import type { SourceRef } from "./types";

export { nativeSource } from "./native";
export type {
  ColumnPredicate,
  DataSource,
  DistinctValue,
  EdgeSelection,
  Endpoints,
  HopCount,
  MaterializeResult,
  NeighborhoodCounts,
  NodeCount,
  NodeHit,
  SourceKind,
  SourceRef,
  SourceSchema,
  SourceTable,
} from "./types";

export { WORKING_SET_LIMIT } from "./limits";

/**
 * How much of a delimited file to read to find out how long its rows are.
 *
 * A fixed bytes-per-row guess is no good: an edge list of short numeric ids
 * runs about twelve bytes a row and one carrying attributes runs ten times
 * that, so any single number is wrong by an order of magnitude for half the
 * files it meets. Wrong in the dangerous direction it lets a file with
 * millions of rows through to be read into memory. Measuring the first block
 * and extrapolating costs one ranged read and is right about the file in hand.
 */
const SAMPLE_BYTES = 64 * 1024;

/**
 * The formats a source can be opened from.
 *
 * Delimited text and parquet: the two shapes that actually arrive at billions
 * of rows, and the two the engine reads natively. GEXF, GraphML, DOT and
 * node-link JSON are graph *documents* rather than tables; they have to be
 * parsed whole to mean anything, so there is nothing for a row budget to carve
 * out of them.
 */
export const SOURCE_EXTENSIONS = [".csv", ".tsv", ".txt", ...PARQUET_EXTENSIONS];

export interface Probe {
  /** Rows, exactly when the format states it, else estimated from the size. */
  rows: number;
  exact: boolean;
  /** True when the file is more than the working set will hold. */
  overLimit: boolean;
}

/**
 * How big a file is, before reading any of it.
 *
 * Parquet says so in its footer, which is a few kilobytes at the end of the
 * file and costs one ranged read; everything else is guessed from the byte
 * count. The point is only to choose a path: under the limit the file opens
 * the way it always has, and over it the engine is worth starting.
 */
export async function probeFile(file: File): Promise<Probe> {
  const lower = file.name.toLowerCase();
  if (PARQUET_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    try {
      const metadata = await parquetMetadataAsync({
        byteLength: file.size,
        slice: (start, end) => file.slice(start, end).arrayBuffer(),
      });
      const rows = Number(metadata.num_rows);
      return { rows, exact: true, overLimit: rows > WORKING_SET_LIMIT };
    } catch {
      // A footer that will not parse is not a reason to refuse the file; the
      // reader itself will say so far more usefully than a probe can.
    }
  }
  return estimateRows(file);
}

/**
 * Rows in a delimited file, estimated from its first block.
 *
 * Counts the line breaks in a sample and scales by the file's own size, so the
 * answer is about this file rather than about files in general. A sample with
 * no line break at all means one enormous row, and the file is reported as
 * itself rather than as an estimate divided by zero.
 */
async function estimateRows(file: File): Promise<Probe> {
  const head = new Uint8Array(await file.slice(0, Math.min(SAMPLE_BYTES, file.size)).arrayBuffer());
  let breaks = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0x0a) breaks++;
  if (breaks === 0) {
    return { rows: file.size > 0 ? 1 : 0, exact: false, overLimit: false };
  }
  // The sample may be the whole file, in which case the count is the answer.
  if (head.length >= file.size) {
    return { rows: breaks, exact: true, overLimit: breaks > WORKING_SET_LIMIT };
  }
  const rows = Math.round((breaks / head.length) * file.size);
  return { rows, exact: false, overLimit: rows > WORKING_SET_LIMIT };
}

/** How a source names itself in a workspace, so it can be found again. */
export function sourceRefOf(file: File): SourceRef {
  return { kind: "file", name: file.name, size: file.size };
}

/** Whether a saved reference matches a file the reader has just offered. */
export function sourceRefMatches(ref: SourceRef, file: File): boolean {
  return ref.kind === "file" && ref.name === file.name && ref.size === file.size;
}
