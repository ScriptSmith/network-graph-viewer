import type { ColumnFilter } from "../../types";
import type { EgoWhere } from "../filter";
import type { ColumnPredicate, EdgeSelection, Endpoints } from "./types";

/**
 * Every statement the engine runs, built here and nowhere else.
 *
 * These are pure functions from a selection to SQL, which is the whole point:
 * an engine that only starts inside a browser with a wasm heap is awkward to
 * assert against, but the SQL it would run is a string, and a string can be
 * tested anywhere. What the backend does at runtime is send these somewhere.
 *
 * Two rules hold throughout. Values travel as bound parameters, never as text
 * spliced into a statement, so an id containing a quote is an id rather than a
 * syntax error. And identifiers are quoted by doubling, since a column named
 * `"` is a column a file can perfectly well contain.
 *
 * Everything that could return rows carries a `LIMIT`. There is no spilling to
 * disk in a wasm32 heap: a query whose intermediates do not fit does not run
 * slowly, it fails, so the budget is part of the statement rather than
 * something checked afterwards.
 */

export type SqlParam = string | number | boolean | null;

export interface Query {
  sql: string;
  params: SqlParam[];
}

/** An identifier, quoted so that any name a file can hold survives. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * An endpoint column read as text. Ids are compared as strings everywhere in
 * the app, and a file is free to store them as integers; casting once here is
 * what stops `1` and `'1'` being two different nodes.
 */
export function idOf(column: string): string {
  return `CAST(${ident(column)} AS VARCHAR)`;
}

/** The reader for a file, by extension. */
export function readerFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".parquet") || lower.endsWith(".pq")) return "read_parquet";
  if (lower.endsWith(".json") || lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) {
    return "read_json_auto";
  }
  return "read_csv_auto";
}

/**
 * A string literal, quoted by doubling.
 *
 * Used in exactly one place, and only because the engine will not take it any
 * other way: DDL cannot be prepared, so `CREATE VIEW ... read_csv_auto(?)` is
 * refused outright. Everything that can bind, binds.
 */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A file registered with the engine, presented as a named view. Every other
 * statement then names the view, so nothing else has to know whether the
 * source was parquet, CSV or a URL.
 *
 * The file name is inlined rather than bound, which is what a statement that
 * cannot be prepared leaves as the only option. It is the name the app itself
 * registered the handle under, and it is escaped either way.
 */
export function createView(view: string, fileName: string): Query {
  return {
    sql:
      `CREATE OR REPLACE VIEW ${ident(view)} AS ` +
      `SELECT * FROM ${readerFor(fileName)}(${literal(fileName)})`,
    params: [],
  };
}

export function describeTable(view: string): Query {
  return { sql: `DESCRIBE SELECT * FROM ${ident(view)}`, params: [] };
}

export function countRows(view: string): Query {
  return { sql: `SELECT count(*) AS n FROM ${ident(view)}`, params: [] };
}

export function distinctValues(view: string, column: string, limit: number): Query {
  return {
    sql:
      `SELECT ${ident(column)} AS value, count(*) AS n FROM ${ident(view)} ` +
      `GROUP BY 1 ORDER BY n DESC, 1 LIMIT ?`,
    params: [limit],
  };
}

export function columnRange(view: string, column: string): Query {
  // TRY_CAST rather than CAST: a text column asked for its range answers with
  // nulls instead of failing the query, which is what the native source does.
  const value = `TRY_CAST(${ident(column)} AS DOUBLE)`;
  return {
    sql: `SELECT min(${value}) AS lo, max(${value}) AS hi FROM ${ident(view)}`,
    params: [],
  };
}

/** How many cells in a column read as numbers, the way `numericValues` counts. */
export function countNumeric(view: string, column: string): Query {
  return {
    sql:
      `SELECT count(*) AS n FROM ${ident(view)} ` +
      `WHERE TRY_CAST(${ident(column)} AS DOUBLE) IS NOT NULL`,
    params: [],
  };
}

/** Bucket counts over a known range, which `columnRange` has already found. */
export function binCounts(
  view: string,
  column: string,
  min: number,
  max: number,
  count: number,
): Query {
  const value = `TRY_CAST(${ident(column)} AS DOUBLE)`;
  // The top of the range would land one past the last bucket, so it is pinned.
  return {
    sql:
      `SELECT least(CAST(floor((${value} - ?) / ?) AS INTEGER), ?) AS bin, count(*) AS n ` +
      `FROM ${ident(view)} WHERE ${value} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    params: [min, (max - min) / count, count - 1],
  };
}

/** Both endpoint columns as one column of ids. */
export function nodesQuery(ends: Endpoints): string {
  return (
    `SELECT ${idOf(ends.source)} AS id FROM ${ident(ends.table)} ` +
    `UNION ALL SELECT ${idOf(ends.target)} FROM ${ident(ends.table)}`
  );
}

/**
 * How many nodes there are, near enough.
 *
 * Deliberately approximate. Counting exactly means a full distinct pass over
 * both endpoint columns of the whole source, which on the files this exists
 * for is minutes of work and an aggregate that may not fit; a card that opens
 * at once and says "about" is the better answer.
 */
export function approxNodeCount(ends: Endpoints): Query {
  return { sql: `SELECT approx_count_distinct(id) AS n FROM (${nodesQuery(ends)})`, params: [] };
}

/**
 * A node directory: the distinct ids, materialized once so that searching is
 * instant afterwards. Only built when the estimate says it will fit.
 */
export function createDirectory(name: string, ends: Endpoints, limit: number): Query {
  return {
    sql:
      `CREATE OR REPLACE TABLE ${ident(name)} AS ` +
      `SELECT DISTINCT id FROM (${nodesQuery(ends)}) WHERE id IS NOT NULL LIMIT ?`,
    params: [limit],
  };
}

export function searchDirectory(name: string, query: string, limit: number): Query {
  return {
    sql:
      `SELECT id FROM ${ident(name)} WHERE contains(lower(id), lower(?)) ` +
      `ORDER BY length(id), id LIMIT ?`,
    params: [query, limit],
  };
}

/**
 * Searching without a directory: a scan of both endpoint columns, stopped as
 * soon as enough matches are in hand. Slower every time, but it is bounded and
 * it works at any size, which is what the alternative is not.
 */
export function searchScan(ends: Endpoints, query: string, limit: number): Query {
  return {
    sql:
      `SELECT DISTINCT id FROM (${nodesQuery(ends)}) ` +
      `WHERE id IS NOT NULL AND contains(lower(id), lower(?)) LIMIT ?`,
    params: [query, limit],
  };
}

/** Ids that actually exist, for validating a pasted list by point lookup. */
export function knownIds(ends: Endpoints, ids: string[]): Query {
  const holes = ids.map(() => "?").join(", ");
  return {
    sql: `SELECT DISTINCT id FROM (${nodesQuery(ends)}) WHERE id IN (${holes}) LIMIT ?`,
    params: [...ids, ids.length],
  };
}

/** One column condition as a SQL fragment, in the two forms the app has. */
export function conditionSql(column: string, op: ColumnFilter): Query | null {
  const col = ident(column);
  if (op.kind === "range") {
    const parts: string[] = [];
    const params: SqlParam[] = [];
    const value = `TRY_CAST(${col} AS DOUBLE)`;
    if (op.min !== null) {
      parts.push(`${value} >= ?`);
      params.push(op.min);
    }
    if (op.max !== null) {
      parts.push(`${value} <= ?`);
      params.push(op.max);
    }
    // An unbounded range still drops rows whose cell is not a number, which is
    // what the compiled condition does in memory.
    parts.push(`${value} IS NOT NULL`);
    return { sql: parts.join(" AND "), params };
  }
  if ("excluded" in op) {
    if (op.excluded.length === 0) return null;
    const holes = op.excluded.map(() => "?").join(", ");
    return {
      sql: `COALESCE(CAST(${col} AS VARCHAR), '') NOT IN (${holes})`,
      params: [...op.excluded],
    };
  }
  if (op.selected.length === 0) return { sql: "false", params: [] };
  const holes = op.selected.map(() => "?").join(", ");
  return { sql: `COALESCE(CAST(${col} AS VARCHAR), '') IN (${holes})`, params: [...op.selected] };
}

/** The walk constraint as a fragment, or null when everything is walkable. */
export function whereSql(where: EgoWhere | undefined): Query | null {
  if (where === undefined) return null;
  return conditionSql(
    where.column,
    "excluded" in where
      ? { kind: "values", excluded: where.excluded }
      : { kind: "values", selected: where.values },
  );
}

/** Every pushed-down predicate, joined. */
export function predicatesSql(predicates: ColumnPredicate[] | undefined): Query | null {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  for (const predicate of predicates ?? []) {
    const one = conditionSql(predicate.column, predicate.op);
    if (one === null) continue;
    parts.push(`(${one.sql})`);
    params.push(...one.params);
  }
  return parts.length === 0 ? null : { sql: parts.join(" AND "), params };
}

/** What a row must satisfy to be walked at all: the constraint and the predicates. */
export function walkableSql(selection: EdgeSelection): Query | null {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  for (const piece of [whereSql(selection.where), predicatesSql(selection.predicates)]) {
    if (piece === null) continue;
    parts.push(`(${piece.sql})`);
    params.push(...piece.params);
  }
  return parts.length === 0 ? null : { sql: parts.join(" AND "), params };
}

const REACHED = "ngv_reached";

export function createReached(): Query {
  return {
    sql: `CREATE OR REPLACE TEMP TABLE ${ident(REACHED)} (id VARCHAR, depth INTEGER)`,
    params: [],
  };
}

export function seedReached(seeds: string[]): Query {
  const holes = seeds.map(() => "(?, 0)").join(", ");
  return { sql: `INSERT INTO ${ident(REACHED)} VALUES ${holes}`, params: [...seeds] };
}

/** Seeds are only nodes if the source names them; the rest are reported missing. */
export function seedFromSource(ends: Endpoints, seeds: string[]): Query {
  const holes = seeds.map(() => "?").join(", ");
  return {
    sql:
      `INSERT INTO ${ident(REACHED)} ` +
      `SELECT DISTINCT id, 0 FROM (${nodesQuery(ends)}) WHERE id IN (${holes})`,
    params: [...seeds],
  };
}

/**
 * One hop: everything adjacent to the last frontier that has not been reached
 * yet, inserted at the new depth. This is the semi-join the whole design turns
 * on, since it never materializes more than the frontier's own neighbourhood.
 */
export function expandHop(selection: EdgeSelection, depth: number): Query {
  const table = ident(selection.table);
  const reached = ident(REACHED);
  const walk = walkableSql(selection);
  const filter = walk === null ? "" : ` AND ${walk.sql}`;

  const arms: string[] = [];
  const armParams: SqlParam[] = [];
  // Following an arrow out means arriving at the target of an edge whose
  // source is in the frontier; "in" is the same sentence backwards.
  if (selection.direction !== "in") {
    arms.push(
      `SELECT ${idOf(selection.target)} AS id FROM ${table} ` +
        `WHERE ${idOf(selection.source)} IN (SELECT id FROM ${reached} WHERE depth = ?)${filter}`,
    );
    armParams.push(depth - 1, ...(walk?.params ?? []));
  }
  if (selection.direction !== "out") {
    arms.push(
      `SELECT ${idOf(selection.source)} AS id FROM ${table} ` +
        `WHERE ${idOf(selection.target)} IN (SELECT id FROM ${reached} WHERE depth = ?)${filter}`,
    );
    armParams.push(depth - 1, ...(walk?.params ?? []));
  }

  // Bound in the order the placeholders are written, which puts the depth
  // being inserted first because its `?` sits in the SELECT list ahead of the
  // subquery. Getting this backwards does not fail: every node still arrives,
  // just all of them at the same depth, and only something that reads the
  // depths afterwards ever notices.
  return {
    sql:
      `INSERT INTO ${reached} SELECT DISTINCT id, ? FROM (${arms.join(" UNION ALL ")}) ` +
      `WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM ${reached}) LIMIT ?`,
    params: [depth, ...armParams, selection.edgeLimit],
  };
}

export function countReached(): Query {
  return { sql: `SELECT count(*) AS n FROM ${ident(REACHED)}`, params: [] };
}

export function countReachedAt(depth: number): Query {
  return { sql: `SELECT count(*) AS n FROM ${ident(REACHED)} WHERE depth = ?`, params: [depth] };
}

/**
 * The rows the selection keeps.
 *
 * With `walkedOnly` off this is the induced subgraph: every row whose two ends
 * were both reached, which is the neighbourhood as the filter chain means it.
 * The walk constraint does **not** appear here, because it governed which
 * edges the walk could step along rather than which rows among reached nodes
 * survive; only the pushed predicates keep filtering, since a row they drop
 * must never enter the working set. On, it is the rows that carried a step
 * from one depth to the next, which is a join against the depths rather than
 * a membership test, and there the constraint stays: a row it drops was never
 * walked.
 */
export function selectRows(selection: EdgeSelection, limit: number): Query {
  const table = ident(selection.table);
  const reached = ident(REACHED);
  const params: SqlParam[] = [];

  const conditions: string[] = [];
  if (selection.walkedOnly === true) {
    const walk = walkableSql(selection);
    const forward = `a.depth + 1 = b.depth`;
    const backward = `b.depth + 1 = a.depth`;
    const step =
      selection.direction === "out"
        ? forward
        : selection.direction === "in"
          ? backward
          : `(${forward} OR ${backward})`;
    const sql =
      `SELECT e.* FROM ${table} e ` +
      `JOIN ${reached} a ON ${idOf(selection.source)} = a.id ` +
      `JOIN ${reached} b ON ${idOf(selection.target)} = b.id ` +
      `WHERE ${step}${walk === null ? "" : ` AND ${walk.sql}`} LIMIT ?`;
    return { sql, params: [...(walk?.params ?? []), limit] };
  }

  const predicates = predicatesSql(selection.predicates);
  conditions.push(`${idOf(selection.source)} IN (SELECT id FROM ${reached})`);
  conditions.push(`${idOf(selection.target)} IN (SELECT id FROM ${reached})`);
  if (predicates !== null) {
    conditions.push(`(${predicates.sql})`);
    params.push(...predicates.params);
  }
  return {
    sql: `SELECT * FROM ${table} WHERE ${conditions.join(" AND ")} LIMIT ?`,
    params: [...params, limit],
  };
}

/** How many rows the selection would keep, so the budget is checked first. */
export function countRowsSelected(selection: EdgeSelection): Query {
  // One more than the budget is all anybody needs to know: the question is
  // whether it fits, and counting past that is work nobody reads.
  const rows = selectRows(selection, selection.edgeLimit + 1);
  return { sql: `SELECT count(*) AS n FROM (${rows.sql})`, params: rows.params };
}

/** The nodes the selection reached, which the working set declares as its own. */
export function selectReachedIds(limit: number): Query {
  return {
    sql: `SELECT id FROM ${ident(REACHED)} ORDER BY depth, id LIMIT ?`,
    params: [limit],
  };
}

/** Reading from the top: no seeds, so the rows themselves are the selection. */
export function selectFromTop(selection: EdgeSelection, limit: number): Query {
  const walk = walkableSql(selection);
  return {
    sql:
      `SELECT * FROM ${ident(selection.table)}` +
      (walk === null ? "" : ` WHERE ${walk.sql}`) +
      ` LIMIT ?`,
    params: [...(walk?.params ?? []), limit],
  };
}

/**
 * How many rows reading from the top has on offer, under the same constraint
 * the read itself applies, so the count and the load can never disagree. An
 * aggregate rather than rows, so it carries no LIMIT and no risk.
 */
export function countFromTop(selection: EdgeSelection): Query {
  const walk = walkableSql(selection);
  return {
    sql:
      `SELECT count(*) AS n FROM ${ident(selection.table)}` +
      (walk === null ? "" : ` WHERE ${walk.sql}`),
    params: [...(walk?.params ?? [])],
  };
}

/**
 * How many distinct nodes the budgeted top read would bring in: the endpoints
 * of exactly the rows `selectFromTop` would return, so the card's count is the
 * loaded graph's count. Bounded by the same limit the read is.
 */
export function countNodesFromTop(selection: EdgeSelection, limit: number): Query {
  const top = selectFromTop(selection, limit);
  return {
    sql:
      `WITH ngv_top AS (${top.sql}) ` +
      `SELECT count(DISTINCT id) AS n FROM (` +
      `SELECT ${idOf(selection.source)} AS id FROM ngv_top ` +
      `UNION ALL SELECT ${idOf(selection.target)} FROM ngv_top` +
      `) WHERE id IS NOT NULL`,
    params: top.params,
  };
}
