import {
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Corner, Graph, GraphDoc, GraphStyle, Row } from "../types";
import { styleColumn } from "../types";
import { cellToId } from "../lib/cells";
import { hasColumn } from "../lib/doc";

interface NodeSearchProps {
  /** Searched in full: every node the document declares, filtered or not. */
  doc: GraphDoc;
  /** The graph on stage, which says which hits are currently hidden. */
  graph: Graph;
  /** The style in force, for the column display names come from. */
  style: GraphStyle;
  /** Where the toolbar is parked, so the matches open into the stage. */
  corner: Corner;
  onPick: (id: string) => void;
  /** Handed in so the app's "/" shortcut can put focus here. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/** One offered node: what it is called, and whether it is currently on stage. */
interface Hit {
  id: string;
  label: string;
  present: boolean;
}

const MAX_MATCHES = 12;
const MAX_RECENT = 5;

/**
 * Type a name, get taken to the node. Matches are a substring of the label or
 * the id, names first.
 *
 * The search runs over the **document**, not the graph on screen. Searching
 * the filtered graph meant a node the chain had removed could not be found at
 * all, which is exactly backwards: not being able to see something is the
 * usual reason for looking for it, and a hidden node is the one someone wants
 * to name as the next centre to expand from. Hits the chain is hiding are
 * offered and marked as such rather than withheld.
 *
 * The box holds a query only while it is being used: clicking away clears it,
 * since a stale query over a live graph reads as a filter that is not there.
 * What it keeps instead are the last few nodes found, offered again when the
 * empty box is focused. They live in memory and never outlast the session:
 * which nodes someone looked for is data about the data, and this app writes
 * nothing about anyone's data anywhere.
 */
export function NodeSearch({ doc, graph, style, corner, onPick, inputRef }: NodeSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Hit[]>([]);
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;

  // The whole point of searching the document is that it is bigger than the
  // stage, so the pass is deferred: a keystroke paints, and the scan catches
  // up behind it rather than holding the character back.
  const deferred = useDeferredValue(query);

  const onStage = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);

  const matches = useMemo(() => {
    const q = deferred.trim().toLowerCase();
    if (q === "") return [];
    const labelColumn = styleColumn(style.nodeLabel);
    const labelCol = labelColumn !== null && hasColumn(doc.nodes, labelColumn) ? labelColumn : null;
    // A type can choose its own label column, and the mark wears that name,
    // so the search answers to it too: the row says what kind the node is,
    // the kind may override the column, the global choice is the fallback.
    const types = style.typeStyles;
    const labelColFor = (row: Row): string | null => {
      if (types !== undefined) {
        const kind = cellToId(row[types.column]);
        if (kind !== null && Object.hasOwn(types.styles, kind)) {
          const override = types.styles[kind].labelColumn;
          if (override !== undefined && hasColumn(doc.nodes, override)) return override;
        }
      }
      return labelCol;
    };

    const starts: Hit[] = [];
    const contains: Hit[] = [];
    for (const row of doc.nodes.rows) {
      const id = cellToId(row[doc.nodeIdColumn]);
      if (id === null) continue;
      const col = labelColFor(row);
      const label = (col === null ? null : cellToId(row[col])) ?? id;
      const lowId = id.toLowerCase();
      const lowLabel = label.toLowerCase();
      if (lowId.startsWith(q) || lowLabel.startsWith(q)) {
        starts.push({ id, label, present: onStage.has(id) });
        // Prefix matches are shown first and on their own fill the list, so
        // enough of them means nothing further can reach the screen.
        if (starts.length >= MAX_MATCHES) break;
      } else if (contains.length < MAX_MATCHES && (lowId.includes(q) || lowLabel.includes(q))) {
        contains.push({ id, label, present: onStage.has(id) });
      }
    }
    return [...starts, ...contains].slice(0, MAX_MATCHES);
  }, [doc, style.nodeLabel, style.typeStyles, onStage, deferred]);

  // Remembered finds, shown while the box is empty. They carry their own name,
  // so all the current graph is asked is whether each is on stage right now.
  const recentNodes = useMemo(
    () => recent.map((hit) => ({ ...hit, present: onStage.has(hit.id) })),
    [onStage, recent],
  );

  const searching = query.trim() !== "";
  const options = searching ? matches : recentNodes;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const showing = open && (searching || recentNodes.length > 0);

  const pick = (hit: Hit) => {
    setRecent((current) =>
      [{ ...hit }, ...current.filter((h) => h.id !== hit.id)].slice(0, MAX_RECENT),
    );
    setQuery("");
    setOpen(false);
    input.current?.blur();
    onPick(hit.id);
  };

  const clear = () => {
    setQuery("");
    setActive(0);
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (options.length > 0) {
        setActive(
          (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
        );
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const chosen = options[activeIndex];
      if (chosen) pick(chosen);
      return;
    }
    if (e.key === "Escape") {
      // One press, one thing: close the list, or let go of the box. Either
      // way it stops here rather than also clearing the app's window.
      e.stopPropagation();
      if (showing) setOpen(false);
      else input.current?.blur();
    }
  };

  return (
    <div className="node-search" data-no-drag="">
      <input
        ref={input}
        className="node-search-input"
        type="text"
        placeholder="Find (/)"
        aria-label="Find a node"
        role="combobox"
        aria-expanded={showing}
        aria-controls={showing ? "node-search-list" : undefined}
        aria-activedescendant={
          showing && options.length > 0 ? `node-search-opt-${activeIndex}` : undefined
        }
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setActive(0);
          setOpen(true);
        }}
        onBlur={() => {
          // Clicking away lets go entirely: a query left sitting over a live
          // graph reads as a filter that is not actually applied.
          setOpen(false);
          setQuery("");
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {searching && (
        <button
          type="button"
          className="node-search-clear"
          // Mousedown, so the press lands before the input's blur wipes it.
          onMouseDown={(e) => {
            e.preventDefault();
            clear();
          }}
          title="Clear the search"
          aria-label="Clear the search"
        >
          ×
        </button>
      )}
      {showing && (
        <ul className={`node-search-menu from-${corner}`} id="node-search-list" role="listbox">
          {!searching && <li className="node-search-head">Recent</li>}
          {options.map((hit, i) => (
            <li
              key={hit.id}
              id={`node-search-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={[
                "node-opt",
                i === activeIndex ? "active" : "",
                hit.present ? "" : "hidden-hit",
              ]
                .filter(Boolean)
                .join(" ")}
              // Mousedown rather than click, so the pick lands before the
              // input's blur closes the list out from under it.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(hit);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="node-opt-label">{hit.label}</span>
              {hit.label !== hit.id && <span className="node-opt-id">{hit.id}</span>}
              {/* Offered, but say so: the reader is about to be taken to a
                  node the chain is holding off the stage. */}
              {!hit.present && (
                <span className="node-opt-note" title="Hidden by the current filters">
                  filtered
                </span>
              )}
            </li>
          ))}
          {searching && options.length === 0 && (
            <li className="node-opt node-opt-empty">No matching node</li>
          )}
        </ul>
      )}
    </div>
  );
}
