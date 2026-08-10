import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import type { DataSource, EdgeSelection, NeighborhoodCounts, SourceSchema } from "../lib/source";
import type { SavedSource } from "../lib/io";
import { compoundKey } from "../lib/cells";
import { formatNumber } from "../lib/format";
import { splitSeedList, whereWalks } from "../lib/filter";

interface SourceCardProps {
  /**
   * Which question the card is asking.
   *
   * `open` is the file that has just arrived and has not been drawn from yet:
   * everything is still to choose, including which columns are the endpoints.
   * `live` is the source behind the graph on screen, where the endpoints are
   * settled (changing them would be a different graph, not a wider one) and
   * the act is to go back for more.
   */
  mode: "open" | "live";
  /** What the source is called on screen: the file's own name. */
  name: string;
  source: DataSource;
  schema: SourceSchema;
  selection: EdgeSelection;
  onSelectionChange: (next: EdgeSelection) => void;
  /** Carve the working set out and hand it to the app. */
  onLoad: () => void;
  loading: boolean;
  /** Absent on a live source: there is nothing to back out of. */
  onCancel?: () => void;
  error: string | null;
}

const SEARCH_LIMIT = 8;

/** The same ceiling the ego editor and the workspace validator hold. */
const MAX_DEPTH = 6;

/**
 * The front door for a source too big to open.
 *
 * A file past the working set's ceiling used to be truncated to its first rows,
 * which is the one answer nobody wants: not the whole graph, and not a piece of
 * it anybody chose. This asks instead. Name the endpoint columns, name a node
 * or two, say how far out to walk, and the engine carves that much out.
 *
 * Everything here is bounded on purpose. The node count is an estimate, says
 * so, and waits to be asked for, because counting is a pass over a file that
 * may be a hundred gigabytes. The edge count comes from a query that stops one
 * past the budget, because the question is only ever whether it fits.
 */
export function SourceCard({
  mode,
  name,
  source,
  schema,
  selection,
  onSelectionChange,
  onLoad,
  loading,
  onCancel,
  error,
}: SourceCardProps) {
  const table = schema.tables.find((t) => t.name === selection.table) ?? schema.tables[0];
  const [nodes, setNodes] = useState<{ value: number; approximate: boolean } | null>(null);
  const [nodesBusy, setNodesBusy] = useState(false);
  const [counts, setCounts] = useState<NeighborhoodCounts | null>(null);
  const [counting, setCounting] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [noMatches, setNoMatches] = useState(false);
  /** How searching answers, when the engine knows: a scan reads the file. */
  const [scanSearch, setScanSearch] = useState(false);
  /** A failed auxiliary query, said out loud rather than shown as emptiness. */
  const [auxError, setAuxError] = useState<string | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  const ends = { table: selection.table, source: selection.source, target: selection.target };
  const endsKey = compoundKey(ends.table, ends.source, ends.target);

  // The endpoint columns changing makes the old node count another table's
  // answer, so it resets; it is only ever fetched on the reader's own click,
  // because it is an aggregate over the whole source.
  useEffect(() => {
    setNodes(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source, endsKey]);

  const countNodes = useCallback(() => {
    setNodesBusy(true);
    setAuxError(null);
    void source
      .nodeCount(ends)
      .then(setNodes)
      .catch(() => setAuxError("The node count failed; the file may not be readable right now."))
      .finally(() => setNodesBusy(false));
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source, endsKey]);

  /**
   * What the selection would bring in. Counted rather than fetched, and only
   * when asked: every keystroke in the seed box must not start a query over a
   * billion rows.
   */
  const recount = useCallback(() => {
    setCounting(true);
    setAuxError(null);
    void source
      .neighborhood(selection)
      .then(setCounts)
      .catch(() => {
        setCounts(null);
        setAuxError("Counting failed; the selection was not checked against the file.");
      })
      .finally(() => setCounting(false));
  }, [source, selection]);

  // One search in flight at a time, and a stale answer is dropped rather than
  // painted over a newer one.
  const searchId = useRef(0);
  useEffect(() => {
    const text = query.trim();
    setNoMatches(false);
    if (text === "") {
      setHits([]);
      return;
    }
    const id = ++searchId.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void source
        .searchNodes(ends, text, SEARCH_LIMIT)
        .then((found) => {
          if (searchId.current !== id) return;
          setHits(found.map((h) => h.id));
          setNoMatches(found.length === 0);
          setScanSearch(source.searchMode?.() === "scan");
        })
        .catch(() => {
          if (searchId.current !== id) return;
          setHits([]);
          setAuxError("The search failed; that is not the same as no matches.");
        })
        .finally(() => {
          if (searchId.current === id) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source, endsKey, query]);

  // The constraint column's values, asked of the engine when one is chosen.
  // Capped: a walk constraint is over kinds of edge, and a column with ten
  // thousand of them is not one.
  const [kinds, setKinds] = useState<{ key: string; count: number }[]>([]);
  const whereColumn = selection.where?.column ?? null;
  useEffect(() => {
    let live = true;
    if (whereColumn === null) {
      setKinds([]);
      return;
    }
    void source
      .distinct(selection.table, whereColumn, 40)
      .then((values) => {
        if (live) setKinds(values.map((v) => ({ key: String(v.value ?? ""), count: v.count })));
      })
      .catch(() => {
        if (live) {
          setKinds([]);
          setAuxError(`Could not read the values of "${whereColumn}" from the file.`);
        }
      });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source, selection.table, whereColumn]);

  const toggleKind = (key: string) => {
    const where = selection.where;
    if (where === undefined) return;
    if ("excluded" in where) {
      const next = where.excluded.includes(key)
        ? where.excluded.filter((k) => k !== key)
        : [...where.excluded, key];
      update({ where: { column: where.column, excluded: next } });
      return;
    }
    // A values-form constraint stays in the values form: inverting it against
    // only the kinds fetched under the cap would silently flip every kind
    // past the cap from excluded to allowed.
    const next = where.values.includes(key)
      ? where.values.filter((k) => k !== key)
      : [...where.values, key];
    update({ where: { column: where.column, values: next } });
  };

  const update = (patch: Partial<EdgeSelection>) => {
    setCounts(null);
    onSelectionChange({ ...selection, ...patch });
  };

  const addSeed = (id: string) => {
    if (selection.seeds.includes(id)) return;
    update({ seeds: [...selection.seeds, id] });
    setQuery("");
    setHits([]);
  };

  /**
   * A pasted list of ids is validated by point lookup, never by a search per
   * id: the found ones become chips, the missing ones are counted out loud.
   */
  const onSeedPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const parts = splitSeedList(e.clipboardData.getData("text"));
    if (parts === null) return;
    e.preventDefault();
    setQuery("");
    setHits([]);
    setPasteNote("Checking the list against the file…");
    const distinct = [...new Set(parts)];
    void source
      .lookupIds(ends, distinct)
      .then((found) => {
        const fresh = found.filter((id) => !selection.seeds.includes(id));
        if (fresh.length > 0) update({ seeds: [...selection.seeds, ...fresh] });
        const missing = distinct.length - found.length;
        setPasteNote(
          missing === 0
            ? `Added ${fresh.length} of ${distinct.length}.`
            : `Added ${fresh.length}; ${missing} of ${distinct.length} not in this file.`,
        );
      })
      .catch(() => {
        setPasteNote(null);
        setAuxError("Could not check that list against the file.");
      });
  };

  const overBudget = counts !== null && counts.truncated;
  const columns = table?.columns ?? [];

  return (
    <section className="source-card" aria-label={`Source ${name}`}>
      <header className="source-head">
        <strong className="source-name">{name}</strong>
        <span className="source-meta">
          {formatNumber(table?.rowCount ?? 0)} edge rows
          {nodes !== null && (
            <>
              {" · "}
              {nodes.approximate ? "~" : ""}
              {formatNumber(nodes.value)} nodes
            </>
          )}
          {nodes === null && (
            <>
              {" · "}
              <button type="button" className="btn-link" onClick={countNodes} disabled={nodesBusy}>
                {nodesBusy ? "counting nodes…" : "count nodes"}
              </button>
            </>
          )}
        </span>
      </header>
      <p className="note">
        {mode === "open"
          ? "Too large to open whole. Choose what to bring in; the rest stays in the file."
          : "The graph is a piece of this file. Widen the selection to go back for more."}
      </p>

      {mode === "open" && (
        <div className="source-row">
          <label className="field">
            <span className="field-label">Source column</span>
            <select
              className="control"
              value={selection.source}
              onChange={(e) => update({ source: e.target.value })}
            >
              {columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Target column</span>
            <select
              className="control"
              value={selection.target}
              onChange={(e) => update({ target: e.target.value })}
            >
              {columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="chain-centres">
        {selection.seeds.map((seed) => (
          <button
            key={seed}
            type="button"
            className="chain-chip"
            onClick={() => update({ seeds: selection.seeds.filter((s) => s !== seed) })}
            title={`Remove ${seed}`}
          >
            {seed} ×
          </button>
        ))}
        {selection.seeds.length === 0 && (
          <span className="note">
            {mode === "open"
              ? "No node chosen; the first rows of the file will be read."
              : "No node chosen; the first rows of the file are what is shown."}
          </span>
        )}
      </div>

      <input
        type="text"
        className="control"
        placeholder="Find a node, or paste a list"
        aria-label="Find a node to start from"
        value={query}
        onChange={(e) => {
          setPasteNote(null);
          setQuery(e.target.value);
        }}
        onPaste={onSeedPaste}
      />
      {searching && (
        <p className="note">
          {scanSearch
            ? "Searching the whole file…"
            : "Searching the file… the first search may build a one-time index."}
        </p>
      )}
      {!searching && noMatches && <p className="note">No nodes match.</p>}
      {scanSearch && !searching && (
        <p className="note">
          This file has too many distinct nodes to index, so each search reads the file.
        </p>
      )}
      {pasteNote !== null && <p className="note">{pasteNote}</p>}
      {hits.length > 0 && (
        <ul className="chain-seed-menu" aria-label="Matching nodes">
          {hits.map((id) => (
            <li key={id}>
              <button type="button" className="chain-seed-opt" onClick={() => addSeed(id)}>
                {id}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="source-row">
        <label className="field">
          <span className="field-label">
            {selection.depth === 0 ? "Chosen nodes only" : `Depth ${selection.depth}`}
          </span>
          <input
            type="range"
            className="range"
            min={0}
            max={MAX_DEPTH}
            step={1}
            value={selection.depth}
            onChange={(e) => update({ depth: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span className="field-label">Direction</span>
          <select
            className="control"
            value={selection.direction}
            onChange={(e) => update({ direction: e.target.value as "any" | "out" | "in" })}
          >
            <option value="any">Either direction</option>
            <option value="out">Follow arrows out</option>
            <option value="in">Follow arrows in</option>
          </select>
        </label>
      </div>

      {/* The walk constraint, in the same two forms the ego step reads. Only
          text columns: walking "along the values of a weight" means nothing. */}
      <label className="field">
        <span className="field-label">Walk edges where</span>
        <select
          className="control"
          value={selection.where?.column ?? ""}
          onChange={(e) =>
            update({
              where: e.target.value === "" ? undefined : { column: e.target.value, excluded: [] },
            })
          }
        >
          <option value="">Any edge</option>
          {columns
            .filter(
              (c) =>
                c.type === "text" && c.name !== selection.source && c.name !== selection.target,
            )
            .map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
        </select>
      </label>
      {selection.where !== undefined && kinds.length > 0 && (
        <div className="cm-values chain-where-values">
          {kinds.map(({ key, count }) => (
            <label key={key} className="check-item">
              <input
                type="checkbox"
                checked={whereWalks(selection.where, key)}
                onChange={() => toggleKind(key)}
              />
              <span className="check-name">{key === "" ? "(blank)" : key}</span>
              <span className="check-count">{formatNumber(count)}</span>
            </label>
          ))}
        </div>
      )}

      <div className="source-meter">
        <button type="button" className="btn btn-quiet" onClick={recount} disabled={counting}>
          {counting ? "Counting…" : "Count what this brings in"}
        </button>
        {counts !== null && (
          <p className={overBudget ? "warn" : "note"}>
            {formatNumber(counts.nodes)} nodes · {formatNumber(counts.edges)} edges
            {overBudget &&
              ` · more than the ${formatNumber(selection.edgeLimit)} row budget, so it will be cut`}
          </p>
        )}
        {counts !== null && counts.hops.length > 1 && (
          <p className="note">
            {counts.hops.map((h) => `${h.depth}: ${formatNumber(h.nodes)}`).join(" · ")}
          </p>
        )}
      </div>

      {auxError !== null && <p className="warn">{auxError}</p>}
      {error !== null && <p className="warn">{error}</p>}

      <div className="source-actions">
        <button type="button" className="btn btn-primary" onClick={onLoad} disabled={loading}>
          {loading ? "Loading…" : mode === "open" ? "Load" : "Reload"}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * A workspace's saved source with no engine behind it: the recipe is known,
 * the file is not on hand. The way back in is to offer the same file again
 * (matched by name and size, which is all a browser can check without reading
 * it) or, for a URL source, to reopen the URL. Until then the graph is just a
 * graph: expanding works through the filter chain, and Reload is not offered
 * because there is nothing to reload from.
 */
export function DetachedSourceCard({
  saved,
  busy,
  error,
  onReattach,
  onReattachUrl,
}: {
  saved: SavedSource;
  busy: boolean;
  error: string | null;
  onReattach: (file: File) => void;
  onReattachUrl: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { ref, selection } = saved;
  const name = ref.kind === "file" ? ref.name : ref.url;
  const recipe = [
    selection.seeds.length === 0
      ? "from the top of the file"
      : `from ${selection.seeds.length} ${selection.seeds.length === 1 ? "node" : "nodes"}`,
    selection.depth === 0 ? "the chosen nodes only" : `depth ${selection.depth}`,
    ...(selection.direction === "any"
      ? []
      : [selection.direction === "out" ? "following arrows out" : "following arrows in"]),
    ...(selection.where !== undefined ? [`walking by ${selection.where.column}`] : []),
  ].join(", ");

  return (
    <section className="source-card" aria-label={`Saved source ${name}`}>
      <header className="source-head">
        <strong className="source-name">{name}</strong>
      </header>
      <p className="note">
        This workspace was carved out of a larger source: {recipe}. Reconnect it to widen the
        selection or expand from its nodes.
      </p>
      {error !== null && <p className="warn">{error}</p>}
      <div className="source-actions">
        {ref.kind === "file" ? (
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onReattach(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? "Reconnecting…" : "Offer the file again"}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onReattachUrl}>
            {busy ? "Reconnecting…" : "Reconnect to the URL"}
          </button>
        )}
      </div>
    </section>
  );
}
