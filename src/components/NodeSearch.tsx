import { useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Corner, Graph, GraphNode } from "../types";

interface NodeSearchProps {
  graph: Graph;
  /** Where the toolbar is parked, so the matches open into the stage. */
  corner: Corner;
  onPick: (id: string) => void;
  /** Handed in so the app's "/" shortcut can put focus here. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

const MAX_MATCHES = 12;
const MAX_RECENT = 5;

/**
 * Type a name, get taken to the node. Matches are a substring of the label or
 * the id, names first, over the graph as currently filtered: a node a filter
 * has removed is not on the stage, so there is nothing to take the reader to.
 *
 * The box holds a query only while it is being used: clicking away clears it,
 * since a stale query over a live graph reads as a filter that is not there.
 * What it keeps instead are the last few nodes found, offered again when the
 * empty box is focused. They live in memory and never outlast the session:
 * which nodes someone looked for is data about the data, and this app writes
 * nothing about anyone's data anywhere.
 */
export function NodeSearch({ graph, corner, onPick, inputRef }: NodeSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    const starts: GraphNode[] = [];
    const contains: GraphNode[] = [];
    for (const node of graph.nodes) {
      const label = node.label.toLowerCase();
      const id = node.id.toLowerCase();
      if (label.startsWith(q) || id.startsWith(q)) starts.push(node);
      else if (label.includes(q) || id.includes(q)) contains.push(node);
    }
    return [...starts, ...contains].slice(0, MAX_MATCHES);
  }, [graph, query]);

  // Remembered finds, shown while the box is empty. Resolved against the
  // current graph, so one that a filter has since removed simply waits.
  const recentNodes = useMemo(() => {
    if (recent.length === 0) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return recent.map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
  }, [graph, recent]);

  const searching = query.trim() !== "";
  const options = searching ? matches : recentNodes;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const showing = open && (searching || recentNodes.length > 0);

  const pick = (node: GraphNode) => {
    setRecent((current) =>
      [node.id, ...current.filter((id) => id !== node.id)].slice(0, MAX_RECENT),
    );
    setQuery("");
    setOpen(false);
    input.current?.blur();
    onPick(node.id);
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
          {options.map((node, i) => (
            <li
              key={node.id}
              id={`node-search-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? "node-opt active" : "node-opt"}
              // Mousedown rather than click, so the pick lands before the
              // input's blur closes the list out from under it.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(node);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="node-opt-label">{node.label}</span>
              {node.label !== node.id && <span className="node-opt-id">{node.id}</span>}
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
