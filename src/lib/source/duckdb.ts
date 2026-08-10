import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import type { CellValue, Column, ColumnType, Row, Table } from "../../types";
import { buildDoc, DEFAULT_NODE_ID_COLUMN } from "../doc";
import type { Bins } from "../histogram";
import { WORKING_SET_LIMIT } from "./limits";
import * as Sql from "./sql";
import type {
  DataSource,
  DistinctValue,
  EdgeSelection,
  Endpoints,
  HopCount,
  MaterializeResult,
  NeighborhoodCounts,
  NodeCount,
  NodeHit,
  SourceSchema,
} from "./types";
import type { Query } from "./sql";

/**
 * The query engine, over a file far bigger than the working set.
 *
 * Reached only through a dynamic `import()` from the page app's open flow, so
 * a session that never opens a large file never fetches the eight megabytes of
 * wasm, and the widget and standalone bundles never carry it at all.
 *
 * Two decisions shape everything here. Opening costs metadata and nothing
 * else: no scans, no aggregates, no directory, because a card that takes a
 * minute to appear has already lost to the thing it replaced. And there is no
 * spilling to disk in a wasm32 heap, so every statement carries a ceiling and
 * the budget is checked by counting before anything is fetched. A selection
 * that will not fit is reported, never attempted.
 */

/** The single-threaded build. Pages cannot set COOP/COEP, so threads are out. */
const BUNDLE = { mainModule: ehWasm, mainWorker: ehWorker };

/** Past this many distinct nodes, searching scans instead of using a directory. */
export const DIRECTORY_LIMIT = 5_000_000;

interface Engine {
  db: AsyncDuckDB;
  connection: AsyncDuckDBConnection;
  worker: Worker;
}

async function start(): Promise<Engine> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const worker = new Worker(BUNDLE.mainWorker, { type: "module" });
  const logger = new duckdb.VoidLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(BUNDLE.mainModule);
  const connection = await db.connect();
  return { db, connection, worker };
}

/** A duckdb value as a cell. The same shapes parquet holds, the same answers. */
export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return isFinite(value) ? value : null;
    case "bigint":
      return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
  }
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * A duckdb type name as a column type. The engine states its schema the way
 * parquet does, so nothing here is a guess off a sample.
 */
export function columnType(sqlType: string): ColumnType {
  const type = sqlType.toUpperCase();
  if (type === "BOOLEAN") return "bool";
  if (
    /^(TINY|SMALL|BIG|HUGE)?INT|^INTEGER|^U?INTEGER|^UINT|^DECIMAL|^NUMERIC|^FLOAT|^DOUBLE|^REAL/.test(
      type,
    )
  ) {
    return "number";
  }
  return "text";
}

/** What the last path segment of a URL calls the file, for the reader choice. */
export function urlFileName(url: string): string {
  try {
    const tail = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    return tail || "remote";
  } catch {
    return "remote";
  }
}

/**
 * A remote file, read over HTTP by byte range. The default bundle carries
 * httpfs, so a parquet footer costs one ranged request the way a local one
 * costs one slice; whether the server allows a cross-origin read is the
 * server's decision, and the error when it does not says so.
 */
export interface RemoteSource {
  url: string;
}

export function duckdbSource(
  input: File | RemoteSource,
  options: { edgeLimit?: number } = {},
): DataSource {
  const budget = options.edgeLimit ?? WORKING_SET_LIMIT;
  const fileName = input instanceof File ? input.name : urlFileName(input.url);
  const view = fileName.replace(/\.[^.]+$/, "") || "Source";
  let engine: Engine | null = null;
  let opening: Promise<Engine> | null = null;
  let disposed = false;
  let directory: string | null = null;
  let directoryFailed = false;

  const teardown = (started: Engine) => {
    void started.connection
      .close()
      .then(() => started.db.terminate())
      .finally(() => started.worker.terminate());
  };

  /** The engine, started once and only when something actually asks. */
  const open = async (): Promise<Engine> => {
    if (disposed) throw new Error("This source was closed.");
    if (engine !== null) return engine;
    opening ??= (async () => {
      try {
        const started = await start();
        // A dropped file is read by byte range through the browser's own
        // reader, a URL by ranged HTTP requests: nothing copies the whole
        // thing into the wasm heap either way.
        const duckdb = await import("@duckdb/duckdb-wasm");
        if (input instanceof File) {
          await started.db.registerFileHandle(
            fileName,
            input,
            duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
            true,
          );
        } else {
          await started.db.registerFileURL(
            fileName,
            input.url,
            duckdb.DuckDBDataProtocol.HTTP,
            false,
          );
        }
        await run(started, Sql.createView(view, fileName));
        // Disposal can arrive while the start was in flight; an engine with no
        // owner left must take itself down rather than hold a worker forever.
        if (disposed) {
          teardown(started);
          throw new Error("This source was closed.");
        }
        engine = started;
        return started;
      } catch (e) {
        // A failed start must not jam the source: the next question asked
        // starts a fresh attempt instead of re-reading a held rejection.
        opening = null;
        throw e;
      }
    })();
    return opening;
  };

  const run = async (target: Engine, query: Query): Promise<Row[]> => {
    if (query.params.length === 0) {
      const result = await target.connection.query(query.sql);
      return rowsOf(result);
    }
    const statement = await target.connection.prepare(query.sql);
    try {
      return rowsOf(await statement.query(...query.params));
    } finally {
      await statement.close();
    }
  };

  const ask = async (query: Query): Promise<Row[]> => run(await open(), query);

  /** One scalar out of a one-row answer. */
  const scalar = async (query: Query, key: string): Promise<CellValue> => {
    const rows = await ask(query);
    return rows[0]?.[key] ?? null;
  };

  const numberOf = (value: CellValue): number => {
    const n = typeof value === "number" ? value : Number(value);
    return isFinite(n) ? n : 0;
  };

  /**
   * The node directory, built at most once and only when the estimate says it
   * will fit. Above the cap there is no directory and every search is a scan,
   * which the card says out loud.
   */
  const directoryFor = async (ends: Endpoints): Promise<string | null> => {
    if (directory !== null) return directory;
    if (directoryFailed) return null;
    const estimate = numberOf(await scalar(Sql.approxNodeCount(ends), "n"));
    if (estimate > DIRECTORY_LIMIT) {
      directoryFailed = true;
      return null;
    }
    const name = "ngv_nodes";
    try {
      await ask(Sql.createDirectory(name, ends, DIRECTORY_LIMIT));
      directory = name;
      return name;
    } catch {
      // A directory that will not fit is not a failure of the search, only of
      // the shortcut, so the scanning path takes over silently.
      directoryFailed = true;
      return null;
    }
  };

  /** Run the walk into the temp table, and report what each hop brought in. */
  const walk = async (selection: EdgeSelection): Promise<HopCount[]> => {
    await ask(Sql.createReached());
    if (selection.seeds.length > 0) await ask(Sql.seedFromSource(selection, selection.seeds));
    const hops: HopCount[] = [
      { depth: 0, nodes: numberOf(await scalar(Sql.countReachedAt(0), "n")) },
    ];
    for (let depth = 1; depth <= selection.depth; depth++) {
      await ask(Sql.expandHop(selection, depth));
      const nodes = numberOf(await scalar(Sql.countReachedAt(depth), "n"));
      hops.push({ depth, nodes });
      if (nodes === 0) break;
    }
    return hops;
  };

  return {
    kind: "duckdb",

    async schema(): Promise<SourceSchema> {
      const described = await ask(Sql.describeTable(view));
      const columns: Column[] = described.map((row) => ({
        name: String(row.column_name ?? ""),
        type: columnType(String(row.column_type ?? "")),
      }));
      const rowCount = numberOf(await scalar(Sql.countRows(view), "n"));
      return { tables: [{ name: view, columns, rowCount }] };
    },

    async distinct(_table, column, limit): Promise<DistinctValue[]> {
      const rows = await ask(Sql.distinctValues(view, column, limit));
      return rows.map((row) => ({ value: row.value ?? null, count: numberOf(row.n) }));
    },

    async range(_table, column) {
      const rows = await ask(Sql.columnRange(view, column));
      const lo = rows[0]?.lo;
      const hi = rows[0]?.hi;
      if (typeof lo !== "number" || typeof hi !== "number") return null;
      return { min: lo, max: hi };
    },

    async bins(table, column, count): Promise<Bins | null> {
      const extent = await this.range(table, column);
      if (extent === null) return null;
      if (extent.min === extent.max) {
        // Numeric cells only, the way `computeBins` over `numericValues`
        // counts: a null or a stray word is not in any bucket.
        const n = numberOf(await scalar(Sql.countNumeric(view, column), "n"));
        return { counts: [n], min: extent.min, max: extent.max, step: 1 };
      }
      const rows = await ask(Sql.binCounts(view, column, extent.min, extent.max, count));
      const counts = new Array<number>(count).fill(0);
      for (const row of rows) {
        const at = numberOf(row.bin);
        if (at >= 0 && at < count) counts[at] = numberOf(row.n);
      }
      // The step the brackets move by is the one `computeBins` would have
      // chosen, worked out from the extent rather than from every value.
      const span = extent.max - extent.min;
      const integers = Number.isInteger(extent.min) && Number.isInteger(extent.max);
      return {
        counts,
        min: extent.min,
        max: extent.max,
        step: integers && span >= 1 ? Math.max(1, Math.round(span / 100)) : span / 100,
      };
    },

    async nodeCount(ends): Promise<NodeCount> {
      const value = numberOf(await scalar(Sql.approxNodeCount(ends), "n"));
      // Always an estimate: counting exactly is a full distinct pass over both
      // endpoint columns, which is the work this exists to avoid.
      return { value, approximate: true };
    },

    async searchNodes(ends, query, limit): Promise<NodeHit[]> {
      if (query.trim() === "") return [];
      const name = await directoryFor(ends);
      const rows = await ask(
        name === null
          ? Sql.searchScan(ends, query, limit)
          : Sql.searchDirectory(name, query, limit),
      );
      return rows.map((row) => ({ id: String(row.id ?? ""), label: null }));
    },

    searchMode() {
      if (directory !== null) return "directory";
      if (directoryFailed) return "scan";
      return null;
    },

    async lookupIds(ends, ids): Promise<string[]> {
      if (ids.length === 0) return [];
      const rows = await ask(Sql.knownIds(ends, ids));
      const known = new Set(rows.map((row) => String(row.id ?? "")));
      const seen = new Set<string>();
      const found: string[] = [];
      // Filtered against the asked list rather than returned as the engine
      // ordered it, so the answer is deduplicated and in the caller's order.
      for (const id of ids) {
        if (seen.has(id) || !known.has(id)) continue;
        seen.add(id);
        found.push(id);
      }
      return found;
    },

    async neighborhood(selection): Promise<NeighborhoodCounts> {
      const bounded = { ...selection, edgeLimit: selection.edgeLimit || budget };
      if (bounded.seeds.length === 0) {
        // Counted under the same constraint the load applies, or the card
        // would promise one graph and Load would bring in another.
        const total = numberOf(await scalar(Sql.countFromTop(bounded), "n"));
        const nodes = numberOf(
          await scalar(Sql.countNodesFromTop(bounded, bounded.edgeLimit), "n"),
        );
        return {
          hops: [],
          nodes,
          edges: Math.min(total, bounded.edgeLimit),
          truncated: total > bounded.edgeLimit,
        };
      }
      const hops = await walk(bounded);
      const nodes = numberOf(await scalar(Sql.countReached(), "n"));
      // Counted, never fetched: the budget question is answered before any
      // rows are built, which is the whole point of asking it separately.
      const edges = numberOf(await scalar(Sql.countRowsSelected(bounded), "n"));
      return {
        hops,
        nodes,
        edges: Math.min(edges, bounded.edgeLimit),
        truncated: edges > bounded.edgeLimit,
      };
    },

    async materialize(selection): Promise<MaterializeResult> {
      const bounded = { ...selection, edgeLimit: selection.edgeLimit || budget };
      const described = await this.schema();
      const columns = described.tables[0]?.columns ?? [];

      let hops: HopCount[] = [];
      let edgeRows: Row[];
      let nodeIds: string[];
      let total: number;

      if (bounded.seeds.length === 0) {
        total = numberOf(await scalar(Sql.countFromTop(bounded), "n"));
        edgeRows = await ask(Sql.selectFromTop(bounded, bounded.edgeLimit));
        const seen = new Set<string>();
        for (const row of edgeRows) {
          const s = row[bounded.source];
          const t = row[bounded.target];
          if (s !== null && s !== undefined) seen.add(String(s));
          if (t !== null && t !== undefined) seen.add(String(t));
        }
        nodeIds = [...seen];
      } else {
        hops = await walk(bounded);
        total = numberOf(await scalar(Sql.countRowsSelected(bounded), "n"));
        edgeRows = await ask(Sql.selectRows(bounded, bounded.edgeLimit));
        nodeIds = (await ask(Sql.selectReachedIds(bounded.edgeLimit))).map((row) =>
          String(row.id ?? ""),
        );
      }

      const edges: Table = { name: view, columns, rows: edgeRows };
      const nodes: Table = {
        name: "Nodes",
        columns: [{ name: DEFAULT_NODE_ID_COLUMN, type: "text" }],
        rows: nodeIds.map((id) => ({ [DEFAULT_NODE_ID_COLUMN]: id })),
      };
      const doc = buildDoc(fileName, edges, {
        nodes,
        mapping: { source: bounded.source, target: bounded.target, attrs: [] },
      });
      return {
        doc,
        hops,
        truncated: total > edgeRows.length ? { read: edgeRows.length, total } : undefined,
      };
    },

    dispose() {
      // Terminal, and safe mid-start: the open path checks the flag when the
      // engine finally arrives and takes it down itself.
      disposed = true;
      const started = engine;
      engine = null;
      opening = null;
      directory = null;
      if (started !== null) teardown(started);
    },
  };
}

/**
 * Arrow's own row objects are proxies over the columnar buffers, and reading
 * one field goes through a getter per access. Copied out once here into plain
 * rows, which is what the whole app is built on.
 */
function rowsOf(result: { toArray(): unknown[] }): Row[] {
  const out: Row[] = [];
  for (const record of result.toArray()) {
    const row: Row = {};
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      row[key] = toCell(value);
    }
    out.push(row);
  }
  return out;
}
