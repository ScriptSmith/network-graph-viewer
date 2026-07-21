import { useEffect, useMemo, useState } from "react";
import type { Filters, Graph, Mapping, Row } from "../types";
import { cellKey, componentCount, distinctValues } from "../lib/graph";
import {
  CENTRALITY_NAMES,
  centralityValues,
  networkMetrics,
  type CentralityKind,
} from "../lib/metrics";
import { asNumber, isNumericColumn } from "../lib/parse";
import { CATEGORICAL } from "../theme";
import { formatMetric, formatNumber } from "../lib/format";

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
  rows: Row[];
  totalRows: number;
  graph: Graph;
  mapping: Mapping;
  /** The partition column currently coloring nodes, if any. */
  colorColumn: string | null;
  colors: Map<string, string>;
  filters: Filters;
  onToggleValueFilter: (column: string, value: string) => void;
  onSelectNode: (id: string) => void;
  onClose: () => void;
}

const MAX_BARS = 12;

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
  rows,
  totalRows,
  graph,
  mapping,
  colorColumn,
  colors,
  filters,
  onToggleValueFilter,
  onSelectNode,
  onClose,
}: StatsPanelProps) {
  const numericColumns = useMemo(
    () => mapping.attrs.filter((c) => isNumericColumn(rows.length > 0 ? rows : [], c)),
    [rows, mapping],
  );

  const groupable = useMemo(() => {
    const cols = [mapping.source, mapping.target, ...mapping.attrs];
    return cols.filter((c) => distinctValues(rows, c).length <= Math.max(40, rows.length / 2));
  }, [rows, mapping]);

  const [groupBy, setGroupBy] = useState<string>(colorColumn ?? groupable[0] ?? mapping.source);
  const [measure, setMeasure] = useState<string>("count");

  // Keep the selects valid when the dataset or mapping changes under us.
  useEffect(() => {
    if (!groupable.includes(groupBy)) {
      setGroupBy(colorColumn ?? groupable[0] ?? mapping.source);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [groupable, colorColumn]);
  useEffect(() => {
    if (measure !== "count" && !numericColumns.includes(measure.slice(4))) {
      setMeasure("count");
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [numericColumns]);

  const bars = useMemo(() => pivot(rows, groupBy, measure), [rows, groupBy, measure]);
  const maxBar = Math.max(1e-9, ...bars.map((b) => b.value));
  const components = useMemo(() => componentCount(graph), [graph]);
  const metrics = useMemo(() => networkMetrics(graph), [graph]);

  const [centralityKind, setCentralityKind] = useState<CentralityKind>("degree");
  const centrality = useMemo(
    () => centralityValues(graph, centralityKind),
    [graph, centralityKind],
  );
  const topNodes = useMemo(() => {
    const score = (id: string) => centrality.get(id) ?? 0;
    return [...graph.nodes].sort((a, b) => score(b.id) - score(a.id)).slice(0, 8);
  }, [graph, centrality]);
  const maxCentrality = Math.max(1e-9, ...topNodes.map((n) => centrality.get(n.id) ?? 0));

  const activeFilter = filters[groupBy];
  const isActiveBar = (key: string) =>
    activeFilter?.kind === "values" &&
    activeFilter.selected.length === 1 &&
    activeFilter.selected[0] === key;

  const barColor = (key: string): string =>
    groupBy === colorColumn ? (colors.get(key) ?? CATEGORICAL[0]) : CATEGORICAL[0];

  const avgDegree = graph.nodes.length > 0 ? (2 * graph.links.length) / graph.nodes.length : 0;

  return (
    <div className="stats-panel" role="dialog" aria-label="Graph statistics">
      <header className="insp-head">
        <h3>Statistics</h3>
        <button
          type="button"
          className="insp-close"
          onClick={onClose}
          aria-label="Close statistics"
        >
          ×
        </button>
      </header>
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
              onClick={() => onToggleValueFilter(groupBy, b.key)}
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
          {bars.length > MAX_BARS && <p className="note">+{bars.length - MAX_BARS} more groups</p>}
          {bars.length === 0 && <p className="note">No rows match the current filters.</p>}
        </div>
        <p className="note">Click a bar to filter the graph to that value; click again to clear.</p>
      </section>

      {topNodes.length > 0 && (
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
                  {CENTRALITY_NAMES[k]}
                  {k === "degree" ? " (connections)" : " centrality"}
                </option>
              ))}
            </select>
          </label>
          <div className="bar-list">
            {topNodes.map((n) => (
              <button
                key={n.id}
                type="button"
                className="bar-row"
                onClick={() => onSelectNode(n.id)}
                title={`Highlight ${n.id} in the graph`}
              >
                <span className="bar-head">
                  <span className="bar-name">{n.id}</span>
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
    </div>
  );
}
