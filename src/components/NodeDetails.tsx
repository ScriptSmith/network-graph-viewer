import { useMemo, useState } from "react";
import type { CellValue, Column, Graph, GraphDoc, GraphLink, GraphStyle, Row } from "../types";
import { edgeDetailColumnsFor, nodeDetailColumnsFor } from "../lib/doc";
import { distinctValues, endpointId, markColor } from "../lib/graph";
import { expansionPreview } from "../lib/expand";
import { imageSource, isRemoteSource } from "../lib/images";
import { type Palette } from "../theme";
import { displayCell } from "../lib/format";

interface NodeDetailsProps {
  doc: GraphDoc;
  graph: Graph;
  /** The style in force: a typed node can choose its own details. */
  style: GraphStyle;
  selectedId: string;
  palette: Palette;
  colors: Map<string, string>;
  /** Whether this node is held in place, and the one control that changes it. */
  pinned: boolean;
  onTogglePin: () => void;
  /** Gates every picture that would mean a request to somebody's server. */
  allowRemoteImages: boolean;
  /** Depth of the exploration's ego step, or null when none is running. */
  egoDepth: number | null;
  onExpandFrom: () => void;
  onEgoDepthChange: (depth: number) => void;
  /** Takes the exploration's ego step back off the chain. */
  onClearExpand: () => void;
  /** The exploration's edge constraint, when its ego step carries one. */
  egoWhere: { column: string; values: string[] } | undefined;
  onEgoWhereChange: (where: { column: string; values: string[] } | undefined) => void;
  /** Whether the path tool is armed and waiting for its far end. */
  pathArmed: boolean;
  /** Whether tracing follows the arrows, adjustable while armed. */
  pathDirected: boolean;
  onPathDirectedChange: (directed: boolean) => void;
  onPathFrom: () => void;
  onCancelPath: () => void;
  /** Writes hop distances from this node as a computed node column. */
  onDistancesFrom: () => void;
  /** This node's distance column when it has one, so the button can undo. */
  distancesColumn: string | null;
  onRemoveDistances: () => void;
  onSelect: (id: string | null) => void;
}

/**
 * One attribute value, rendered the way its column's role asks: a link as an
 * anchor (http(s) only, opened without a referrer or an opener), an image as a
 * thumbnail behind the same consent every other remote picture waits on, and
 * everything else as text. A role never fetches anything by itself: the anchor
 * is only an anchor, and the thumbnail waits.
 */
function AttrValue({
  column,
  value,
  allowRemote,
}: {
  column: Column;
  value: CellValue;
  allowRemote: boolean;
}) {
  if (column.role === "url" && typeof value === "string") {
    const href = value.trim();
    if (/^https?:\/\//i.test(href)) {
      return (
        <a className="cell-link" href={href} target="_blank" rel="noopener noreferrer">
          {href}
        </a>
      );
    }
  }
  if (column.role === "image") {
    const source = imageSource(value);
    if (source !== null && (allowRemote || !isRemoteSource(source))) {
      return <img className="insp-thumb" src={source} referrerPolicy="no-referrer" alt="" />;
    }
  }
  return <>{displayCell(column, value)}</>;
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
  const end = direction === "out" ? link.target : link.source;
  const other = endpointId(end);
  const otherLabel = typeof end === "string" ? end : end.label;
  const row = link.rows[0] as Row | undefined;
  const details = row ? attrColumns.filter((c) => row[c] !== null && row[c] !== "") : [];
  return (
    <div className="edge-card">
      <button type="button" className="edge-other" onClick={() => onSelect(other)}>
        <span className="edge-dir">{direction === "out" ? "→" : "←"}</span>
        {otherLabel}
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
export function NodeDetails({
  doc,
  graph,
  style,
  selectedId,
  palette,
  colors,
  pinned,
  onTogglePin,
  allowRemoteImages,
  egoDepth,
  onExpandFrom,
  onEgoDepthChange,
  onClearExpand,
  egoWhere,
  onEgoWhereChange,
  pathArmed,
  pathDirected,
  onPathDirectedChange,
  onPathFrom,
  onCancelPath,
  onDistancesFrom,
  distancesColumn,
  onRemoveDistances,
  onSelect,
}: NodeDetailsProps) {
  const [previewOpen, setPreviewOpen] = useState(false);

  const nodeTypeColumn = style.typeStyles?.column ?? null;
  const edgeTypeColumn = style.edgeTypeStyles?.column ?? null;

  // One pass over the edge rows, and only while the disclosure is open: what
  // another hop from here would actually bring in, counted by kind.
  const preview = useMemo(() => {
    if (!previewOpen) return null;
    const visible = new Set(graph.nodes.map((n) => n.id));
    return expansionPreview(doc, visible, selectedId, nodeTypeColumn, edgeTypeColumn);
  }, [previewOpen, graph, doc, selectedId, nodeTypeColumn, edgeTypeColumn]);

  // With nothing hidden there is nothing to arrive, so the preview describes
  // the neighbourhood itself instead: what expanding would narrow the view
  // to, which is the question "Expand from here" actually answers first.
  const neighbourhood = useMemo(() => {
    if (!previewOpen || preview === null || preview.total > 0) return null;
    return expansionPreview(doc, new Set([selectedId]), selectedId, nodeTypeColumn, edgeTypeColumn);
  }, [previewOpen, preview, doc, selectedId, nodeTypeColumn, edgeTypeColumn]);

  // Unchecking a line materialises the constraint over every value the
  // column holds, the way the Filter step's own editor does, so the first
  // toggle narrows by one value rather than to one value.
  const toggleEdgeType = (kind: string) => {
    if (edgeTypeColumn === null) return;
    const all = distinctValues(doc.edges.rows, edgeTypeColumn).map((v) => v.key);
    const current =
      egoWhere !== undefined && egoWhere.column === edgeTypeColumn ? egoWhere.values : all;
    const values = current.includes(kind) ? current.filter((v) => v !== kind) : [...current, kind];
    // Back to every value ticked means back to no constraint at all.
    onEgoWhereChange(
      values.length === all.length && all.every((v) => values.includes(v))
        ? undefined
        : { column: edgeTypeColumn, values },
    );
  };

  const walked = (kind: string): boolean =>
    egoWhere === undefined || egoWhere.column !== edgeTypeColumn || egoWhere.values.includes(kind);

  const node = graph.nodes.find((n) => n.id === selectedId);
  if (!node) return null;

  const outgoing = graph.links.filter((l) => endpointId(l.source) === selectedId);
  const incoming = graph.links.filter((l) => endpointId(l.target) === selectedId);

  const nodeAttrs = nodeDetailColumnsFor(doc, style, node.row).filter(
    (c) => node.row[c.name] !== null && node.row[c.name] !== "",
  );
  const tint = markColor(node, graph.ranking, colors, palette);

  return (
    <section className="node-details" aria-label={`Details for ${node.id}`}>
      <header className="insp-head">
        {/* The picture stands in for the colour dot when there is one, ringed
            in the node's colour so the grouping still reads. A remote one
            waits for the same permission the canvas waits for: selecting a
            node is not consent to tell a host the graph was opened. */}
        {node.image === null || (!allowRemoteImages && isRemoteSource(node.image)) ? (
          <span className="legend-dot" style={{ background: tint }} />
        ) : (
          <img
            className="insp-image"
            src={node.image}
            referrerPolicy="no-referrer"
            alt=""
            style={{ borderColor: tint }}
          />
        )}
        <h3>{node.label}</h3>
        <button
          type="button"
          className={pinned ? "insp-pin active" : "insp-pin"}
          onClick={onTogglePin}
          aria-pressed={pinned}
          title={pinned ? "Unpin: let the layout place it again" : "Pin where it is now"}
        >
          {pinned ? "Pinned" : "Pin"}
        </button>
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
        {node.label !== node.id ? `${node.id} · ` : ""}
        {node.group ? `${node.group} · ` : ""}
        {incoming.length} in · {outgoing.length} out
      </p>
      {/* Progressive expansion: each press folds this node's reach into the
          view. The control edits the chain's ego step, so the exploration
          shows in the Filter step and travels with the workspace, and the
          cross beside the stepper takes the whole step back off. */}
      <div className="expand-row">
        <button
          type="button"
          className="btn"
          onClick={onExpandFrom}
          title={
            egoDepth === null
              ? "Narrow the view to this node's neighbourhood, then grow it node by node"
              : "Add this node to the centers the view is grown from"
          }
        >
          Expand from here
        </button>
        {egoDepth !== null && (
          <span className="hop-stepper">
            <button
              type="button"
              onClick={() => onEgoDepthChange(egoDepth - 1)}
              disabled={egoDepth <= 1}
              aria-label="One hop fewer"
            >
              −
            </button>
            {egoDepth} hop{egoDepth === 1 ? "" : "s"}
            <button
              type="button"
              onClick={() => onEgoDepthChange(egoDepth + 1)}
              disabled={egoDepth >= 6}
              aria-label="One hop more"
            >
              +
            </button>
            <button
              type="button"
              onClick={onClearExpand}
              aria-label="Stop expanding: show the whole graph again"
              title="Stop expanding: takes the exploration's filter step off the chain"
            >
              ×
            </button>
          </span>
        )}
      </div>
      <details
        className="expand-preview"
        open={previewOpen}
        onToggle={(e) => setPreviewOpen(e.currentTarget.open)}
      >
        <summary>Preview the next hop</summary>
        {preview &&
          (() => {
            // With hidden neighbours the preview is what would arrive; with
            // none it is the neighbourhood the expand would narrow down to.
            const arriving = preview.total > 0;
            const shown = arriving ? preview : (neighbourhood ?? preview);
            return (
              <>
                <p className="insp-meta">
                  {arriving
                    ? `+${preview.total} node${preview.total === 1 ? "" : "s"} one hop out.`
                    : egoDepth === null
                      ? `Nothing is filtered away, so there is nothing to bring in. Expanding narrows the view to this node and its ${shown.total} neighbour${shown.total === 1 ? "" : "s"} first; grow it from there.`
                      : `All ${shown.total} of this node's neighbour${shown.total === 1 ? "" : "s"} are already in view.`}
                </p>
                {shown.byNodeType.length > 0 && (
                  <ul className="expand-kinds">
                    {shown.byNodeType.map(({ kind, count }) => (
                      <li key={kind}>
                        {arriving ? "+" : ""}
                        {count} {kind === "" ? "(untyped)" : kind}
                      </li>
                    ))}
                  </ul>
                )}
                {shown.byEdgeType.length > 0 &&
                  edgeTypeColumn !== null &&
                  (egoDepth !== null ? (
                    // Wired straight to the exploration's edge constraint: an
                    // unticked line is not walked anywhere in the ego step.
                    <fieldset className="check-list">
                      <legend className="field-label">Via {edgeTypeColumn}</legend>
                      {shown.byEdgeType.map(({ kind, count }) => (
                        <label key={kind} className="check-item">
                          <input
                            type="checkbox"
                            checked={walked(kind)}
                            onChange={() => toggleEdgeType(kind)}
                          />
                          <span className="check-name">{kind === "" ? "(blank)" : kind}</span>
                          <span className="check-count">{count}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <p className="note">
                      Via{" "}
                      {shown.byEdgeType
                        .map(({ kind, count }) => `${kind === "" ? "(blank)" : kind} (${count})`)
                        .join(", ")}
                      .
                    </p>
                  ))}
              </>
            );
          })()}
      </details>
      {/* The path tool arms here and resolves on the next node picked; the
          distances tool writes a computed column, and pressing it again
          takes the column back off. */}
      <div className="expand-row">
        <button
          type="button"
          className="btn"
          onClick={pathArmed ? onCancelPath : onPathFrom}
          title={
            pathArmed
              ? "Stop waiting for the far end"
              : "Trace the shortest route from this node to the next one you select"
          }
        >
          {pathArmed ? "Cancel path" : "Path from here…"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={distancesColumn === null ? onDistancesFrom : onRemoveDistances}
          title={
            distancesColumn === null
              ? 'Write each node\'s hop distance from this one as a "Hops from" column'
              : `Delete the "${distancesColumn}" column`
          }
        >
          {distancesColumn === null ? "Distances from here" : "Remove distances"}
        </button>
      </div>
      {pathArmed && (
        <>
          <p className="note">Now pick the far end: click a node, or walk to it and press Enter.</p>
          <label className="check-item">
            <input
              type="checkbox"
              checked={pathDirected}
              onChange={(e) => onPathDirectedChange(e.target.checked)}
            />
            <span className="check-name">Follow arrows only</span>
          </label>
        </>
      )}
      {nodeAttrs.length > 0 && (
        <section className="insp-section">
          <h4>Attributes</h4>
          <dl className="edge-attrs">
            {nodeAttrs.map((c) => (
              <div key={c.name} className="edge-attr">
                <dt>{c.name}</dt>
                <dd>
                  <AttrValue column={c} value={node.row[c.name]} allowRemote={allowRemoteImages} />
                </dd>
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
              attrColumns={edgeDetailColumnsFor(doc, style, l.rows as Row[])}
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
              attrColumns={edgeDetailColumnsFor(doc, style, l.rows as Row[])}
              onSelect={onSelect}
            />
          ))}
        </section>
      )}
    </section>
  );
}
