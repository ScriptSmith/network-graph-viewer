import { useCallback, useRef, useState } from "react";
import { probeFile, sourceRefOf, sourceRefMatches, WORKING_SET_LIMIT } from "./lib/source";
import type {
  DataSource,
  EdgeSelection,
  MaterializeResult,
  SourceRef,
  SourceSchema,
} from "./lib/source";
import type { SavedSource } from "./lib/io";

/**
 * The one owner of a source engine's lifetime.
 *
 * The protocol used to be spread over App's callbacks, each knowing a slice
 * of it, which is exactly how loading a sample over a live source left the
 * old engine attached and double-click re-materializing the old file over the
 * new graph. Here the whole of it lives in one place: a source is `pending`
 * (opened, waiting for a selection), `live` (behind the working set on
 * stage), or `detached` (named by a reopened workspace, its recipe known but
 * its engine gone), and every document arrival calls `release`, which lets
 * all of it go. The only arrival that must not release is the one that
 * promotes the pending source itself, which is `load`'s own act.
 */

/** A source opened and waiting for the reader to say what to take from it. */
export interface PendingSource {
  name: string;
  ref: SourceRef;
  source: DataSource;
  schema: SourceSchema;
  selection: EdgeSelection;
}

/**
 * The source the working set on stage was carved from, kept live.
 *
 * Held rather than closed because the working set is a view of something
 * larger, and the questions that follow are asked of the source rather than
 * of the view: expanding from a node at the edge of a neighbourhood has to go
 * back to the file, since the rows it wants were never brought in.
 */
export interface LiveSource {
  ref: SourceRef;
  source: DataSource;
  schema: SourceSchema;
  selection: EdgeSelection;
}

/** How an engine is obtained, injectable so the tests hand in a fake. */
export type EngineFactory = (input: File | { url: string }) => Promise<DataSource>;

const defaultEngine: EngineFactory = async (input) => {
  // `#duckdb` is aliased per vite config: the page build gets the engine, the
  // widget and standalone builds get a stub that throws, because a library
  // build would fold the wasm into a bundle that must stay small.
  const { duckdbSource } = await import("#duckdb");
  return duckdbSource(input);
};

export interface SourceApi {
  /** A file too large to open whole, waiting for the reader's selection. */
  pending: PendingSource | null;
  /** True from a drop being claimed until the card has a schema to show. */
  opening: boolean;
  /** The open card's Load in flight. */
  pendingBusy: boolean;
  pendingError: string | null;
  live: LiveSource | null;
  /** The live card's Reload (or a re-attach) in flight. */
  liveBusy: boolean;
  liveError: string | null;
  /** A workspace's saved recipe with no engine behind it yet. */
  detached: SavedSource | null;
  /** Mirror of `live` for handlers installed once; always current. */
  liveRef: { readonly current: LiveSource | null };
  /** Open a file as a source if it is over the limit. True when claimed. */
  open: (file: File) => Promise<boolean>;
  /** Open a remote URL as a source. Always source-backed; throws on failure. */
  openUrl: (url: string) => Promise<void>;
  setPendingSelection: (next: EdgeSelection) => void;
  setLiveSelection: (next: EdgeSelection) => void;
  /** Materialize the pending selection and promote it to live. */
  load: () => Promise<MaterializeResult | null>;
  /** Materialize a new selection against the live source. */
  reload: (selection: EdgeSelection) => Promise<MaterializeResult | null>;
  /** Adopt a reopened workspace's saved source as a detached recipe. */
  restore: (saved: SavedSource | null) => void;
  /** Re-attach a detached file recipe by offering the file again. */
  reattach: (file: File) => Promise<void>;
  /** Re-attach a detached URL recipe by reopening the URL. */
  reattachUrl: () => Promise<void>;
  /** Back out of the pending source. */
  cancel: () => void;
  /** Let everything go; called from every document-arrival path. */
  release: () => void;
}

/** http(s) only, and never credentials: the same rule `validSource` holds. */
export function checkSourceUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That does not look like a URL.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Only http(s) URLs can be opened.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "URLs carrying credentials are not opened: a workspace must never hold a secret.";
  }
  return null;
}

/**
 * Leads the message rather than trailing it: the engine's own error is a wall
 * of SQL, and a hint parked after it is a hint nobody reads.
 */
const CORS_HINT =
  "Could not read that URL. If the file exists, its server may not allow cross-origin reads (CORS), which the browser reports only as a failed fetch.";

export function useSource(options: { engineFor?: EngineFactory } = {}): SourceApi {
  const engineFor = options.engineFor ?? defaultEngine;
  const [pending, setPending] = useState<PendingSource | null>(null);
  const [opening, setOpening] = useState(false);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSource | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [detached, setDetached] = useState<SavedSource | null>(null);

  // Refs mirror the states that async work and once-installed handlers read,
  // written through the setters below so they can never drift.
  const pendingRef = useRef<PendingSource | null>(null);
  const liveRef = useRef<LiveSource | null>(null);
  const detachedRef = useRef<SavedSource | null>(null);

  const putPending = useCallback((next: PendingSource | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);
  const putLive = useCallback((next: LiveSource | null) => {
    liveRef.current = next;
    setLive(next);
  }, []);
  const putDetached = useCallback((next: SavedSource | null) => {
    detachedRef.current = next;
    setDetached(next);
  }, []);

  /**
   * Orphans any open still in flight: an open that comes back to find the
   * world has moved on disposes its own engine instead of installing it.
   */
  const generation = useRef(0);

  const dropPending = useCallback(() => {
    generation.current++;
    pendingRef.current?.source.dispose();
    putPending(null);
    setOpening(false);
    setPendingBusy(false);
    setPendingError(null);
  }, [putPending]);

  const cancel = useCallback(() => {
    dropPending();
  }, [dropPending]);

  const release = useCallback(() => {
    dropPending();
    liveRef.current?.source.dispose();
    putLive(null);
    setLiveBusy(false);
    setLiveError(null);
    putDetached(null);
  }, [dropPending, putLive, putDetached]);

  /** Start an engine over a file or URL and read its schema. */
  const openSource = useCallback(
    async (input: File | { url: string }, name: string, ref: SourceRef): Promise<PendingSource> => {
      const source = await engineFor(input);
      try {
        const schema = await source.schema();
        const table = schema.tables[0];
        if (!table || table.columns.length < 2) {
          throw new Error(`"${name}" needs at least two columns to be an edge list.`);
        }
        return {
          name,
          ref,
          source,
          schema,
          selection: {
            table: table.name,
            source: table.columns[0].name,
            target: table.columns[1].name,
            seeds: [],
            depth: 1,
            direction: "any",
            edgeLimit: WORKING_SET_LIMIT,
          },
        };
      } catch (e) {
        source.dispose();
        throw e;
      }
    },
    [engineFor],
  );

  const open = useCallback(
    async (file: File): Promise<boolean> => {
      const probe = await probeFile(file);
      if (!probe.overLimit) return false;
      // A second drop replaces whatever was pending; the file was claimed the
      // moment the probe said it was too large, so failures from here on are
      // this path's own to report.
      dropPending();
      const gen = generation.current;
      setOpening(true);
      try {
        const next = await openSource(file, file.name, sourceRefOf(file));
        if (generation.current !== gen) {
          // Cancelled or replaced while the engine was starting.
          next.source.dispose();
          return true;
        }
        putPending(next);
        return true;
      } finally {
        if (generation.current === gen) setOpening(false);
      }
    },
    [dropPending, openSource, putPending],
  );

  const openUrl = useCallback(
    async (url: string): Promise<void> => {
      const reason = checkSourceUrl(url);
      if (reason !== null) throw new Error(reason);
      dropPending();
      const gen = generation.current;
      setOpening(true);
      try {
        const parsed = new URL(url);
        const next = await openSource({ url: parsed.toString() }, parsed.toString(), {
          kind: "url",
          url: parsed.toString(),
        });
        if (generation.current !== gen) {
          next.source.dispose();
          return;
        }
        putPending(next);
      } catch (e) {
        if (e instanceof Error && checkSourceUrl(url) === null) {
          throw new Error(`${CORS_HINT} (${e.message})`);
        }
        throw e;
      } finally {
        if (generation.current === gen) setOpening(false);
      }
    },
    [dropPending, openSource, putPending],
  );

  const setPendingSelection = useCallback(
    (next: EdgeSelection) => {
      const current = pendingRef.current;
      if (current !== null) putPending({ ...current, selection: next });
    },
    [putPending],
  );

  const setLiveSelection = useCallback(
    (next: EdgeSelection) => {
      const current = liveRef.current;
      if (current !== null) putLive({ ...current, selection: next });
    },
    [putLive],
  );

  const load = useCallback(async (): Promise<MaterializeResult | null> => {
    const current = pendingRef.current;
    if (current === null) return null;
    setPendingBusy(true);
    setPendingError(null);
    try {
      const result = await current.source.materialize(current.selection);
      if (pendingRef.current?.source !== current.source) {
        // Cancelled or replaced while materializing; the engine is gone.
        return null;
      }
      if (result.doc.edges.rows.length === 0) {
        setPendingError("That selection is empty. Try another node, or a greater depth.");
        return null;
      }
      // Promote: the pending engine becomes the live one. Whatever was live
      // belonged to the document this load replaces, and a reopened
      // workspace's detached recipe is likewise superseded.
      liveRef.current?.source.dispose();
      putLive({
        ref: current.ref,
        source: current.source,
        schema: current.schema,
        selection: current.selection,
      });
      setLiveError(null);
      putDetached(null);
      putPending(null);
      return result;
    } catch (e) {
      setPendingError(e instanceof Error ? e.message : "The engine could not read that.");
      return null;
    } finally {
      setPendingBusy(false);
    }
  }, [putLive, putDetached, putPending]);

  const reload = useCallback(
    async (selection: EdgeSelection): Promise<MaterializeResult | null> => {
      const current = liveRef.current;
      if (current === null) return null;
      setLiveBusy(true);
      setLiveError(null);
      try {
        const result = await current.source.materialize(selection);
        if (liveRef.current?.source !== current.source) return null;
        if (result.doc.edges.rows.length === 0) {
          setLiveError("That selection is empty; the view is unchanged.");
          return null;
        }
        putLive({ ...current, selection });
        return result;
      } catch (e) {
        setLiveError(e instanceof Error ? e.message : "The engine could not read that.");
        return null;
      } finally {
        setLiveBusy(false);
      }
    },
    [putLive],
  );

  const restore = useCallback(
    (saved: SavedSource | null) => {
      putDetached(saved);
      setLiveError(null);
    },
    [putDetached],
  );

  /** Turn a detached recipe live again around a freshly offered engine. */
  const attach = useCallback(
    async (saved: SavedSource, input: File | { url: string }) => {
      setLiveBusy(true);
      setLiveError(null);
      const gen = generation.current;
      try {
        const source = await engineFor(input);
        try {
          const schema = await source.schema();
          if (generation.current !== gen || detachedRef.current !== saved) {
            source.dispose();
            return;
          }
          putLive({ ref: saved.ref, source, schema, selection: saved.selection });
          putDetached(null);
        } catch (e) {
          source.dispose();
          throw e;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "The engine could not open that.";
        setLiveError(
          saved.ref.kind === "url" && checkSourceUrl(saved.ref.url) === null
            ? `${CORS_HINT} (${message})`
            : message,
        );
      } finally {
        setLiveBusy(false);
      }
    },
    [engineFor, putLive, putDetached],
  );

  const reattach = useCallback(
    async (file: File) => {
      const saved = detachedRef.current;
      if (saved === null) return;
      if (!sourceRefMatches(saved.ref, file)) {
        const expected =
          saved.ref.kind === "file" ? `"${saved.ref.name}" (${saved.ref.size} bytes)` : "a URL";
        setLiveError(`That is not the saved source. This workspace came out of ${expected}.`);
        return;
      }
      await attach(saved, file);
    },
    [attach],
  );

  const reattachUrl = useCallback(async () => {
    const saved = detachedRef.current;
    if (saved === null || saved.ref.kind !== "url") return;
    await attach(saved, { url: saved.ref.url });
  }, [attach]);

  return {
    pending,
    opening,
    pendingBusy,
    pendingError,
    live,
    liveBusy,
    liveError,
    detached,
    liveRef,
    open,
    openUrl,
    setPendingSelection,
    setLiveSelection,
    load,
    reload,
    restore,
    reattach,
    reattachUrl,
    cancel,
    release,
  };
}
