import type { GraphDoc, Row } from "../types";
import { asTime } from "./parse";

/**
 * What the timeline strip can run along: number columns as they are, and
 * text columns whose cells read as dates. The window step itself goes
 * through `asTime` either way, so what is offered is what will filter.
 */

export interface TimeColumnOption {
  table: "nodes" | "edges";
  column: string;
  /** True when the cells are dates, so the strip labels them as dates. */
  dates: boolean;
}

const SAMPLE = 50;

function textReadsAsDates(rows: Row[], column: string): boolean {
  let seen = 0;
  let parsed = 0;
  for (const row of rows) {
    const v = row[column];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string") return false;
    seen++;
    if (asTime(v) !== null) parsed++;
    if (seen >= SAMPLE) break;
  }
  return seen > 0 && parsed * 2 >= seen;
}

/**
 * Whether a number column reads as a time axis rather than a measurement:
 * every sampled value has to look like a year or an epoch. Names are no
 * guide here; "Years together" is a duration and "Meetings per month" is a
 * rate, and a timeline over either would be nonsense wearing an axis.
 */
function numberReadsAsTime(rows: Row[], column: string): boolean {
  let seen = 0;
  let timeLike = 0;
  for (const row of rows) {
    const v = row[column];
    if (typeof v !== "number") continue;
    seen++;
    const year = Number.isInteger(v) && v >= 1000 && v <= 3000;
    const epoch = v >= 1e8; // seconds since 1973, or anything in milliseconds
    if (year || epoch) timeLike++;
    if (seen >= SAMPLE) break;
  }
  return seen > 0 && timeLike === seen;
}

export function timeColumns(doc: GraphDoc): TimeColumnOption[] {
  const out: TimeColumnOption[] = [];
  const structural = new Set([doc.mapping.source, doc.mapping.target, doc.nodeIdColumn]);
  const tables: ["edges" | "nodes", (typeof doc)["edges"]][] = [
    ["edges", doc.edges],
    ["nodes", doc.nodes],
  ];
  for (const [table, t] of tables) {
    for (const column of t.columns) {
      if (structural.has(column.name)) continue;
      // A declared role settles it either way, the way the color columns
      // work: "Treat as time" in the column menu overrides the census.
      if (column.role !== undefined) {
        if (column.role === "time") {
          out.push({ table, column: column.name, dates: column.type === "text" });
        }
        continue;
      }
      if (column.type === "number" && numberReadsAsTime(t.rows, column.name)) {
        out.push({ table, column: column.name, dates: false });
      } else if (column.type === "text" && textReadsAsDates(t.rows, column.name)) {
        out.push({ table, column: column.name, dates: true });
      }
    }
  }
  return out;
}

/** The time coordinates a column holds, in row order, unreadable cells dropped. */
export function timeValues(rows: Row[], column: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const t = asTime(row[column]);
    if (t !== null) out.push(t);
  }
  return out;
}

/** A time coordinate back as something readable: a date, or the number itself. */
export function formatTime(value: number, dates: boolean): string {
  if (!dates) {
    return Math.abs(value) >= 1000
      ? Math.round(value).toLocaleString()
      : String(Math.round(value * 100) / 100);
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}
