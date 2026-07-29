import type { Graph, GraphDoc, GraphLink, Row } from "../types";
import { endpointId } from "../lib/graph";
import { nodeColor } from "../theme";
import { displayCell } from "../lib/format";

interface NodeDetailsProps {
  doc: GraphDoc;
  graph: Graph;
  selectedId: string;
  colors: Map<string, string>;
  onSelect: (id: string | null) => void;
}

function EdgeCard({
  link,
  direction,
  attrColumns,
  onSelect,
}: {
  link: GraphLink;
  direction: "in" | "out";
  attrColumns: string[];
  onSelect: (id: string) => void;
}) {
  const other = direction === "out" ? endpointId(link.target) : endpointId(link.source);
  const row = link.rows[0] as Row | undefined;
  const details = row ? attrColumns.filter((c) => row[c] !== null && row[c] !== "") : [];
  return (
    <div className="edge-card">
      <button type="button" className="edge-other" onClick={() => onSelect(other)}>
        <span className="edge-dir">{direction === "out" ? "→" : "←"}</span>
        {other}
      </button>
      {details.length > 0 && (
        <dl className="edge-attrs">
          {details.map((c) => (
            <div key={c} className="edge-attr">
              <dt>{c}</dt>
              <dd>{String((row as Row)[c])}</dd>
            </div>
          ))}
        </dl>
      )}
      {link.rows.length > 1 && <p className="note">+{link.rows.length - 1} more rows</p>}
    </div>
  );
}

/**
 * The selected node, at the head of the statistics panel: who it is, what it
 * carries, and what it connects to. It sits above the whole-graph numbers
 * rather than in a panel of its own, so clicking a node answers in the place
 * the reader is already looking.
 */
export function NodeDetails({ doc, graph, selectedId, colors, onSelect }: NodeDetailsProps) {
  const node = graph.nodes.find((n) => n.id === selectedId);
  if (!node) return null;

  const attrColumns = doc.mapping.attrs;
  const outgoing = graph.links.filter((l) => endpointId(l.source) === selectedId);
  const incoming = graph.links.filter((l) => endpointId(l.target) === selectedId);

  const nodeAttrs = doc.nodes.columns.filter(
    (c) => c.name !== doc.nodeIdColumn && node.row[c.name] !== null && node.row[c.name] !== "",
  );

  return (
    <section className="node-details" aria-label={`Details for ${node.id}`}>
      <header className="insp-head">
        <span className="legend-dot" style={{ background: nodeColor(node.group, colors) }} />
        <h3>{node.id}</h3>
        <button
          type="button"
          className="insp-close"
          onClick={() => onSelect(null)}
          title="Clear the selection"
          aria-label="Clear the selection"
        >
          ×
        </button>
      </header>
      <p className="insp-meta">
        {node.group ? `${node.group} · ` : ""}
        {incoming.length} in · {outgoing.length} out
      </p>
      {nodeAttrs.length > 0 && (
        <section className="insp-section">
          <h4>Attributes</h4>
          <dl className="edge-attrs">
            {nodeAttrs.map((c) => (
              <div key={c.name} className="edge-attr">
                <dt>{c.name}</dt>
                <dd>{displayCell(c, node.row[c.name])}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {outgoing.length > 0 && (
        <section className="insp-section">
          <h4>Outgoing</h4>
          {outgoing.map((l, i) => (
            <EdgeCard
              key={`o${i}`}
              link={l}
              direction="out"
              attrColumns={attrColumns}
              onSelect={onSelect}
            />
          ))}
        </section>
      )}
      {incoming.length > 0 && (
        <section className="insp-section">
          <h4>Incoming</h4>
          {incoming.map((l, i) => (
            <EdgeCard
              key={`i${i}`}
              link={l}
              direction="in"
              attrColumns={attrColumns}
              onSelect={onSelect}
            />
          ))}
        </section>
      )}
    </section>
  );
}
