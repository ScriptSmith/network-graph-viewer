import { useEffect, useMemo, useState } from "react";
import type { Filters, Graph, Mapping, Row } from "../types";
import { cellKey, componentCount, distinctValues } from "../lib/graph";
import { asNumber, isNumericColumn } from "../lib/parse";
import { CATEGORICAL } from "../theme";
import { formatNumber } from "../lib/format";

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

  const topNodes = useMemo(
    () => [...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, 8),
    [graph],
  );
  const maxDegree = Math.max(1, ...topNodes.map((n) => n.degree));

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
          <h4>Most connected</h4>
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
                  <span className="bar-value">{n.degree}</span>
                </span>
                <span className="bar-track">
                  <span
                    className="bar-fill neutral"
                    style={{ width: `${Math.max(1.5, (100 * n.degree) / maxDegree)}%` }}
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
