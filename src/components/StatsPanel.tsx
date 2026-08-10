import { useEffect, useMemo, useState } from "react";
import type { BaseGraph, Graph, GraphDoc, GraphSelection, GraphStyle, Row } from "../types";
import { findValueStep, type FilterStep } from "../lib/filter";
import { cellKey, edgeKey } from "../lib/cells";
import { componentCount } from "../lib/graph";
import type { EgoWhere } from "../lib/filter";
import { groupable as isGroupable } from "../lib/stats";
import { CENTRALITY_NAMES, graphMetrics, toMetricGraph, type CentralityKind } from "../lib/metrics";
import { computeCentrality } from "../lib/metrics/runner";
import { maxOf } from "../lib/numbers";
import { asNumber } from "../lib/parse";
import { parseColor, type Palette } from "../theme";
import { formatMetric, formatNumber } from "../lib/format";
import { NodeDetails } from "./NodeDetails";
import { EdgeDetails } from "./EdgeDetails";

const METRIC_HELP: { term: string; text: string }[] = [
  {
    term: "Density",
    text: "The share of possible connections that actually exist. 1 means everyone connects directly to everyone else.",
  },
  {
    term: "Components",
    text: "Separate islands: groups of nodes with no connections between them.",
  },
  {
    term: "Diameter",
    text: "The longest shortest path: how many steps apart the two most distant reachable nodes are.",
  },
  {
    term: "Avg path length",
    text: "The typical number of steps between two nodes, averaged over every pair that can reach each other.",
  },
  {
    term: "Clustering",
    text: "How often two neighbors of the same node are also connected to each other, from 0 to 1. High values mean tight cliques.",
  },
  {
    term: "Degree",
    text: "The number of connections a node has. The simplest measure of importance.",
  },
  {
    term: "Betweenness",
    text: "How often a node sits on the shortest path between two others. High scorers are brokers and bottlenecks; removing them fragments the network.",
  },
  {
    term: "Closeness",
    text: "How few steps a node needs to reach everyone else. High scorers can spread information through the whole network fastest.",
  },
  {
    term: "Eigenvector",
    text: "Like degree, but connections to well-connected nodes count for more. High scorers have influence, not just volume.",
  },
];

interface StatsPanelProps {
  doc: GraphDoc;
  rows: Row[];
  totalRows: number;
  graph: Graph;
  /** The style in force, which the typed details resolve against. */
  style: GraphStyle;
  /**
   * The same graph before any appearance settings were applied. Everything
   * counted rather than drawn reads this one, so restyling the graph does not
   * make the panel recount a network that did not change.
   */
  base: BaseGraph;
  /** The partition column currently coloring nodes, if any. */
  colorColumn: string | null;
  palette: Palette;
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  chain: FilterStep[];
  /** The node or edge whose details head the panel, if anything is selected. */
  selection: GraphSelection | null;
  pinned: ReadonlySet<string>;
  onTogglePin: (id: string) => void;
  allowRemoteImages: boolean;
  /** Depth of the exploration's ego step, or null when none is running. */
  egoDepth: number | null;
  onExpandFrom: (id: string) => void;
  onEgoDepthChange: (depth: number) => void;
  onClearExpand: () => void;
  /** The exploration's edge constraint, when its ego step carries one. */
  egoWhere: EgoWhere | undefined;
  onEgoWhereChange: (where: EgoWhere | undefined) => void;
  /** Whether the path tool is waiting for its far end to be picked. */
  pathArmed: boolean;
  onPathFrom: (id: string) => void;
  onCancelPath: () => void;
  onDistancesFrom: (id: string) => void;
  /** The selected node's distance column when one exists, so it can undo. */
  distancesColumn: string | null;
  onRemoveDistances: (column: string) => void;
  /** The last traced route, answered as a fact rather than only as paint. */
  pathResult: {
    from: string;
    to: string;
    routes: string[][];
    count: number;
    routeIndex: number;
    forward: number;
  } | null;
  /** Whether path tracing follows the arrows or ignores them. */
  pathDirected: boolean;
  onPathDirectedChange: (directed: boolean) => void;
  /** Light another of the equally short routes. */
  onPickRoute: (index: number) => void;
  onClearPath: () => void;
  onToggleValueFilter: (table: "nodes" | "edges", column: string, value: string) => void;
  onSelectNode: (id: string | null) => void;
  onClose: () => void;
}

const MAX_BARS = 12;

const RANK_OPTION_LABELS: Record<CentralityKind, string> = {
  degree: "Degree (connections)",
  betweenness: "Betweenness centrality",
  closeness: "Closeness centrality",
  eigenvector: "Eigenvector centrality",
  harmonic: "Harmonic closeness",
  pagerank: "PageRank",
};

interface PivotRow {
  key: string;
  value: number;
}

function pivot(rows: Row[], groupBy: string, measure: string): PivotRow[] {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = cellKey(row[groupBy]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (measure !== "count") {
      const col = measure.slice(4);
      const v = asNumber(row[col]);
      if (v !== null) sums.set(key, (sums.get(key) ?? 0) + v);
    }
  }
  const result: PivotRow[] = [];
  for (const [key, count] of counts) {
    if (measure === "count") {
      result.push({ key, value: count });
    } else if (measure.startsWith("sum:")) {
      result.push({ key, value: sums.get(key) ?? 0 });
    } else {
      result.push({ key, value: (sums.get(key) ?? 0) / count });
    }
  }
  return result.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

export function StatsPanel({
  doc,
  rows,
  totalRows,
  graph,
  style,
  base,
  colorColumn,
  palette,
  colors,
  edgeColors,
  chain,
  selection,
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
  onPathFrom,
  onCancelPath,
  onDistancesFrom,
  distancesColumn,
  onRemoveDistances,
  pathResult,
  pathDirected,
  onPathDirectedChange,
  onPickRoute,
  onClearPath,
  onToggleValueFilter,
  onSelectNode,
  onClose,
}: StatsPanelProps) {
  const { mapping } = doc;

  const numericColumns = useMemo(
    () =>
      doc.edges.columns
        .filter((c) => c.type === "number" && mapping.attrs.includes(c.name))
        .map((c) => c.name),
    [doc, mapping],
  );

  const groupable = useMemo(() => {
    const cols = [mapping.source, mapping.target, ...mapping.attrs];
    const limit = Math.max(40, rows.length / 2);
    return cols.filter((c) => isGroupable(rows, c, limit));
  }, [rows, mapping]);

  // The color column can live on the node table, which these edge-row pivots
  // know nothing about, so it only seeds the pivot when it is groupable here.
  const defaultGroupBy =
    colorColumn !== null && groupable.includes(colorColumn)
      ? colorColumn
      : (groupable[0] ?? mapping.source);

  const [groupBy, setGroupBy] = useState<string>(defaultGroupBy);
  const [measure, setMeasure] = useState<string>("count");

  // Keep the selects valid when the dataset or mapping changes under us.
  useEffect(() => {
    if (!groupable.includes(groupBy)) setGroupBy(defaultGroupBy);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [groupable, defaultGroupBy]);
  useEffect(() => {
    if (measure !== "count" && !numericColumns.includes(measure.slice(4))) {
      setMeasure("count");
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [numericColumns]);

  const bars = useMemo(() => pivot(rows, groupBy, measure), [rows, groupBy, measure]);
  const maxBar = maxOf(
    bars.map((b) => b.value),
    1e-9,
  );
  const components = useMemo(() => componentCount(base), [base]);
  const metrics = useMemo(() => graphMetrics(base), [base]);

  /**
   * Rankings are computed in the worker, because two of the six cost a
   * breadth-first search per node and this panel renders on every change to the
   * graph. Degree is the exception: it is already counted on the node, so it
   * answers instantly and the panel opens with a ranking rather than a wait.
   */
  const [centralityKind, setCentralityKind] = useState<CentralityKind>("degree");
  const [centrality, setCentrality] = useState<Map<string, number>>(() => new Map());
  const [ranking, setRanking] = useState<"ready" | "working" | "failed">("ready");

  useEffect(() => {
    if (centralityKind === "degree") {
      setCentrality(new Map(base.nodes.map((n) => [n.id, n.degree])));
      setRanking("ready");
      return;
    }
    let live = true;
    setRanking("working");
    void computeCentrality(toMetricGraph(base), centralityKind)
      .then((scores) => {
        if (!live) return;
        setCentrality(scores);
        setRanking("ready");
      })
      .catch(() => {
        if (!live) return;
        setCentrality(new Map());
        setRanking("failed");
      });
    // A ranking that is still running when the graph changes under it is an
    // answer to a question nobody is asking any more.
    return () => {
      live = false;
    };
  }, [base, centralityKind]);

  const topNodes = useMemo(() => {
    if (centrality.size === 0) return [];
    const score = (id: string) => centrality.get(id) ?? 0;
    return [...base.nodes].sort((a, b) => score(b.id) - score(a.id)).slice(0, 8);
  }, [base, centrality]);
  // Rankings run over the structural graph, whose nodes predate the label
  // column; the styled one knows what each node is called on screen.
  const labelOf = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.label])), [graph]);
  const maxCentrality = maxOf(
    topNodes.map((n) => centrality.get(n.id) ?? 0),
    1e-9,
  );

  // A bar reads as active when the chain holds exactly the step clicking it
  // adds. The pivots run over edge rows, so that is the table it matches on.
  const isActiveBar = (key: string) => findValueStep(chain, "edges", groupBy, key) !== undefined;

  // Bars grouped by the column that colors the graph wear its colors: a palette
  // slot, or the cell itself when the column is one the marks read directly.
  const barColor = (key: string): string =>
    groupBy === colorColumn
      ? (colors.get(key) ?? parseColor(key) ?? palette.categorical[0])
      : palette.categorical[0];

  const avgDegree = graph.nodes.length > 0 ? (2 * graph.links.length) / graph.nodes.length : 0;

  return (
    <aside className="stats-panel" aria-label="Information">
      <header className="panel-head">
        <h2>Information</h2>
        <button
          type="button"
          className="insp-close"
          onClick={onClose}
          title="Hide the information panel"
          aria-label="Hide the information panel"
        >
          ×
        </button>
      </header>

      {/* The panel splits in two: facts about what is picked out on the
          canvas above, the whole network's numbers below. */}
      <section className="info-zone" aria-label="Facts about the selection">
        <h3 className="info-zone-head">Facts</h3>

        {selection?.kind === "node" && (
          <NodeDetails
            doc={doc}
            graph={graph}
            style={style}
            selectedId={selection.id}
            palette={palette}
            colors={colors}
            pinned={pinned.has(selection.id)}
            onTogglePin={() => onTogglePin(selection.id)}
            allowRemoteImages={allowRemoteImages}
            egoDepth={egoDepth}
            onExpandFrom={() => onExpandFrom(selection.id)}
            onEgoDepthChange={onEgoDepthChange}
            onClearExpand={onClearExpand}
            egoWhere={egoWhere}
            onEgoWhereChange={onEgoWhereChange}
            pathArmed={pathArmed}
            pathDirected={pathDirected}
            onPathDirectedChange={onPathDirectedChange}
            onPathFrom={() => onPathFrom(selection.id)}
            onCancelPath={onCancelPath}
            onDistancesFrom={() => onDistancesFrom(selection.id)}
            distancesColumn={distancesColumn}
            onRemoveDistances={() => distancesColumn && onRemoveDistances(distancesColumn)}
            onSelect={onSelectNode}
          />
        )}

        {selection?.kind === "edge" && (
          <EdgeDetails
            key={edgeKey(selection.source, selection.target)}
            doc={doc}
            graph={graph}
            style={style}
            edge={selection}
            palette={palette}
            colors={colors}
            edgeColors={edgeColors}
            onSelectNode={onSelectNode}
            onClear={() => onSelectNode(null)}
          />
        )}

        {pathResult && (
          <section className="insp-section path-card" aria-label="Traced path">
            <h4>
              Path
              <button
                type="button"
                className="insp-close"
                onClick={onClearPath}
                title="Clear the traced path"
                aria-label="Clear the traced path"
              >
                ×
              </button>
            </h4>
            {pathResult.routes.length === 0 ? (
              <p className="insp-meta">
                No path between {labelOf.get(pathResult.from) ?? pathResult.from} and{" "}
                {labelOf.get(pathResult.to) ?? pathResult.to}
                {pathDirected
                  ? " along the arrows. Untick the box below to walk edges either way."
                  : ": they sit on different islands of the current view."}
              </p>
            ) : (
              (() => {
                const route = pathResult.routes[pathResult.routeIndex];
                const hops = route.length - 1;
                return (
                  <>
                    <p className="insp-meta">
                      {hops} hop{hops === 1 ? "" : "s"} on the graph as filtered
                      {pathResult.count > 1
                        ? `, one of ${pathResult.count.toLocaleString()} equally short routes`
                        : ", and the only route this short"}
                      .
                    </p>
                    {!pathDirected && hops > 0 && (
                      <p className="insp-meta">
                        {pathResult.forward === hops
                          ? "Follows the arrows the whole way."
                          : `Follows the arrows on ${pathResult.forward} of ${hops} hops.`}
                      </p>
                    )}
                    {pathResult.routes.length > 1 && (
                      <div className="expand-row">
                        <span className="hop-stepper">
                          <button
                            type="button"
                            onClick={() => onPickRoute(pathResult.routeIndex - 1)}
                            disabled={pathResult.routeIndex === 0}
                            aria-label="Light the previous route"
                          >
                            −
                          </button>
                          route {pathResult.routeIndex + 1} of {pathResult.routes.length}
                          {pathResult.count > pathResult.routes.length ? " listed" : ""}
                          <button
                            type="button"
                            onClick={() => onPickRoute(pathResult.routeIndex + 1)}
                            disabled={pathResult.routeIndex >= pathResult.routes.length - 1}
                            aria-label="Light the next route"
                          >
                            +
                          </button>
                        </span>
                      </div>
                    )}
                    <ol className="path-route">
                      {route.map((id) => (
                        <li key={id}>
                          <button
                            type="button"
                            className="path-stop"
                            onClick={() => onSelectNode(id)}
                            title={`Select ${labelOf.get(id) ?? id}`}
                          >
                            {labelOf.get(id) ?? id}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </>
                );
              })()
            )}
            <label className="check-item">
              <input
                type="checkbox"
                checked={pathDirected}
                onChange={(e) => onPathDirectedChange(e.target.checked)}
              />
              <span className="check-name">Follow arrows only</span>
            </label>
          </section>
        )}

        {selection === null && pathResult === null && (
          <p className="note">
            Select a node or an edge, or trace a path between two nodes, and its facts land here.
          </p>
        )}
      </section>

      <div className="info-divider" role="presentation" />

      <section className="info-zone" aria-label="Whole-network statistics">
        <h3 className="info-zone-head">Network</h3>

        {rows.length < totalRows && (
          <p className="insp-meta">
            {rows.length} of {totalRows} rows after filters
          </p>
        )}

        <div className="stat-tiles">
          <div className="stat-tile">
            <span className="stat-value">{graph.nodes.length}</span>
            <span className="stat-label">nodes</span>
          </div>
          <div className="stat-tile">
            <span className="stat-value">{graph.links.length}</span>
            <span className="stat-label">edges</span>
          </div>
          <div className="stat-tile">
            <span className="stat-value">{formatNumber(avgDegree)}</span>
            <span className="stat-label">avg links</span>
          </div>
          <div className="stat-tile">
            <span className="stat-value">{components}</span>
            <span className="stat-label">components</span>
          </div>
        </div>

        <section className="insp-section">
          <h4>Network metrics</h4>
          <div className="metric-rows">
            <div className="metric-row">
              <span className="metric-name">Density</span>
              <span className="metric-value">{formatMetric(metrics.density)}</span>
            </div>
            <div className="metric-row">
              <span className="metric-name">Diameter</span>
              <span className="metric-value">{formatMetric(metrics.diameter)}</span>
            </div>
            <div className="metric-row">
              <span className="metric-name">Avg path length</span>
              <span className="metric-value">{formatMetric(metrics.avgPathLength)}</span>
            </div>
            <div className="metric-row">
              <span className="metric-name">Clustering</span>
              <span className="metric-value">{formatMetric(metrics.clustering)}</span>
            </div>
          </div>
          {metrics.approximate && (
            <p className="note">Large graph: path measures estimated from sampled nodes.</p>
          )}
          <details className="metric-help">
            <summary>What do these mean?</summary>
            <dl>
              {METRIC_HELP.map((h) => (
                <div key={h.term}>
                  <dt>{h.term}</dt>
                  <dd>{h.text}</dd>
                </div>
              ))}
            </dl>
            <p className="note">All measures treat connections as undirected.</p>
          </details>
        </section>

        <section className="insp-section">
          <h4>Breakdown</h4>
          <div className="pivot-controls">
            <label className="field">
              <span className="field-label">Group by</span>
              <select
                className="control"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
              >
                {groupable.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Measure</span>
              <select
                className="control"
                value={measure}
                onChange={(e) => setMeasure(e.target.value)}
              >
                <option value="count">Edge count</option>
                {numericColumns.map((c) => (
                  <option key={`sum:${c}`} value={`sum:${c}`}>
                    Sum of {c}
                  </option>
                ))}
                {numericColumns.map((c) => (
                  <option key={`avg:${c}`} value={`avg:${c}`}>
                    Average {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="bar-list">
            {bars.slice(0, MAX_BARS).map((b) => (
              <button
                key={b.key}
                type="button"
                className={isActiveBar(b.key) ? "bar-row active" : "bar-row"}
                onClick={() => onToggleValueFilter("edges", groupBy, b.key)}
                title={`Filter to ${groupBy} = ${b.key === "" ? "(blank)" : b.key}`}
              >
                <span className="bar-head">
                  <span className="bar-name">{b.key === "" ? "(blank)" : b.key}</span>
                  <span className="bar-value">{formatNumber(b.value)}</span>
                </span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{
                      width: `${Math.max(1.5, (100 * b.value) / maxBar)}%`,
                      background: barColor(b.key),
                    }}
                  />
                </span>
              </button>
            ))}
            {bars.length > MAX_BARS && (
              <p className="note">+{bars.length - MAX_BARS} more groups</p>
            )}
            {bars.length === 0 && <p className="note">No rows match the current filters.</p>}
          </div>
          <p className="note">
            Click a bar to filter the graph to that value; click again to clear.
          </p>
        </section>

        {base.nodes.length > 0 && (
          <section className="insp-section">
            <h4>Top nodes</h4>
            <label className="field">
              <span className="field-label">Rank by</span>
              <select
                className="control"
                value={centralityKind}
                onChange={(e) => setCentralityKind(e.target.value as CentralityKind)}
              >
                {(Object.keys(CENTRALITY_NAMES) as CentralityKind[]).map((k) => (
                  <option key={k} value={k}>
                    {RANK_OPTION_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            {ranking === "working" && (
              <p className="note" role="status">
                Ranking by {RANK_OPTION_LABELS[centralityKind].toLowerCase()}…
              </p>
            )}
            {ranking === "failed" && (
              <p className="note">That ranking could not be computed for this graph.</p>
            )}
            <div className="bar-list">
              {topNodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="bar-row"
                  onClick={() => onSelectNode(n.id)}
                  title={`Highlight ${labelOf.get(n.id) ?? n.id} in the graph`}
                >
                  <span className="bar-head">
                    <span className="bar-name">{labelOf.get(n.id) ?? n.id}</span>
                    <span className="bar-value">{formatMetric(centrality.get(n.id) ?? 0)}</span>
                  </span>
                  <span className="bar-track">
                    <span
                      className="bar-fill neutral"
                      style={{
                        width: `${Math.max(1.5, (100 * (centrality.get(n.id) ?? 0)) / maxCentrality)}%`,
                      }}
                    />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </section>
    </aside>
  );
}
