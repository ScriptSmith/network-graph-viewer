import type { Graph, GraphDoc, Row } from "../types";
import { endpointId, markColor } from "../lib/graph";
import { NEUTRAL, nodeColor, type Palette } from "../theme";

interface EdgeDetailsProps {
  doc: GraphDoc;
  graph: Graph;
  edge: { source: string; target: string };
  palette: Palette;
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  onSelectNode: (id: string) => void;
  onClear: () => void;
}

/**
 * The selected edge, in the place a selected node is answered. One link can
 * stand for several spreadsheet rows, so every row behind it gets a card
 * rather than only the first, which is the whole reason the pair is the
 * selection and a row is not.
 */
export function EdgeDetails({
  doc,
  graph,
  edge,
  palette,
  colors,
  edgeColors,
  onSelectNode,
  onClear,
}: EdgeDetailsProps) {
  const link = graph.links.find(
    (l) => endpointId(l.source) === edge.source && endpointId(l.target) === edge.target,
  );
  if (!link) return null;

  const attrColumns = doc.mapping.attrs;
  const rows = link.rows as Row[];
  // Each end wears the same dot it wears in the graph and at the head of its
  // own card, and the arrow between them takes the edge's own color.
  const dot = (id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return nodeColor(null, colors, palette.categorical);
    return markColor(node, graph.ranking, colors, palette);
  };
  const arrowColor =
    link.color ??
    (link.colorValue === null ? undefined : (edgeColors.get(link.colorValue) ?? NEUTRAL));

  return (
    <section
      className="node-details"
      aria-label={`Details for the edge from ${edge.source} to ${edge.target}`}
    >
      <header className="insp-head">
        <h3 className="insp-edge">
          <button type="button" className="insp-end" onClick={() => onSelectNode(edge.source)}>
            <span className="legend-dot" style={{ background: dot(edge.source) }} />
            {edge.source}
          </button>
          <span className="edge-dir" aria-hidden="true" style={{ color: arrowColor }}>
            →
          </span>
          <button type="button" className="insp-end" onClick={() => onSelectNode(edge.target)}>
            <span className="legend-dot" style={{ background: dot(edge.target) }} />
            {edge.target}
          </button>
        </h3>
        <button
          type="button"
          className="insp-close"
          onClick={onClear}
          title="Clear the selection"
          aria-label="Clear the selection"
        >
          ×
        </button>
      </header>
      <p className="insp-meta">
        {rows.length === 1 ? "1 row" : `${rows.length} rows`}
        {link.colorValue ? ` · ${link.colorValue}` : ""}
      </p>
      {rows.map((row, i) => {
        const details = attrColumns.filter((c) => row[c] !== null && row[c] !== "");
        if (details.length === 0) return null;
        return (
          <div key={i} className="edge-card">
            <dl className="edge-attrs">
              {details.map((c) => (
                <div key={c} className="edge-attr">
                  <dt>{c}</dt>
                  <dd>{String(row[c])}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </section>
  );
}
