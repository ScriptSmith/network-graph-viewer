import type { Graph, GraphLink, Row } from "../types";
import { nodeColor } from "../theme";

interface InspectorProps {
  graph: Graph;
  selectedId: string;
  attrColumns: string[];
  colors: Map<string, string>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const endpoint = (e: GraphLink["source"]): string => (typeof e === "string" ? e : e.id);

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
  const other = direction === "out" ? endpoint(link.target) : endpoint(link.source);
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

export function Inspector({
  graph,
  selectedId,
  attrColumns,
  colors,
  onSelect,
  onClose,
}: InspectorProps) {
  const node = graph.nodes.find((n) => n.id === selectedId);
  if (!node) return null;

  const outgoing = graph.links.filter((l) => endpoint(l.source) === selectedId);
  const incoming = graph.links.filter((l) => endpoint(l.target) === selectedId);

  return (
    <div className="inspector" role="dialog" aria-label={`Details for ${node.id}`}>
      <header className="insp-head">
        <span className="legend-dot" style={{ background: nodeColor(node.group, colors) }} />
        <h3>{node.id}</h3>
        <button type="button" className="insp-close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>
      <p className="insp-meta">
        {node.group ? `${node.group} · ` : ""}
        {incoming.length} in · {outgoing.length} out
      </p>
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
    </div>
  );
}
