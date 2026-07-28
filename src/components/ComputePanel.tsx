import { useMemo, useState } from "react";
import type { GraphDoc } from "../types";
import {
  DEFAULT_METRIC_OPTIONS,
  METRICS,
  type MetricOptions,
  type MetricRunResult,
} from "../lib/metrics";
import type { MetricRun } from "../lib/metrics/runner";
import { edgeStyleColumns } from "../lib/doc";
import type { EditTarget } from "../lib/edit";
import { formatMetric } from "../lib/format";

interface ComputePanelProps {
  doc: GraphDoc;
  nodeCount: number;
  edgeCount: number;
  onCompute: (metrics: string[], options: MetricOptions) => Promise<MetricRun>;
  onClearComputed: () => void;
  /** Opens the data table on the tab holding the columns just written. */
  onShowColumns: (target: EditTarget) => void;
}

/** Above this many nodes the all-pairs measures are worth warning about. */
const HEAVY_NODE_WARNING = 2000;

interface LastRun {
  nodeColumns: string[];
  edgeColumns: string[];
  elapsedMs: number;
  offMainThread: boolean;
  summary: MetricRunResult["summary"];
}

export function ComputePanel({
  doc,
  nodeCount,
  edgeCount,
  onCompute,
  onClearComputed,
  onShowColumns,
}: ComputePanelProps) {
  const [selected, setSelected] = useState<string[]>(["degree", "pagerank", "louvain"]);
  const [options, setOptions] = useState<MetricOptions>(DEFAULT_METRIC_OPTIONS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  const weightColumns = useMemo(
    () => edgeStyleColumns(doc).filter((c) => c.type === "number"),
    [doc],
  );

  const computedColumns = useMemo(
    () => [...doc.nodes.columns, ...doc.edges.columns].filter((c) => c.computed),
    [doc],
  );

  const toggle = (id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const heavySelected = selected.some((id) => METRICS.find((m) => m.id === id)?.cost === "heavy");

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { result, elapsedMs, offMainThread } = await onCompute(selected, options);
      setLastRun({
        nodeColumns: result.nodeColumns.map((c) => c.name),
        edgeColumns: result.edgeColumns.map((c) => c.name),
        elapsedMs,
        offMainThread,
        summary: result.summary,
      });
      // Land the user on whichever table now holds the most new columns.
      if (result.nodeColumns.length + result.edgeColumns.length > 0) {
        onShowColumns(result.nodeColumns.length >= result.edgeColumns.length ? "nodes" : "edges");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not compute those metrics.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="compute-panel">
      <p className="note">
        Computed over the {nodeCount} nodes and {edgeCount} edges currently in view. Results become
        columns on the Nodes and Edges tables, ready to colour, size, filter, sort and export by.
      </p>

      <fieldset className="check-list">
        <legend className="field-label">Measures</legend>
        {METRICS.map((metric) => (
          <label key={metric.id} className="check-item metric-item" title={metric.blurb}>
            <input
              type="checkbox"
              checked={selected.includes(metric.id)}
              onChange={() => toggle(metric.id)}
            />
            <span className="check-name">{metric.name}</span>
            {metric.cost === "heavy" && <span className="check-count">slow</span>}
          </label>
        ))}
      </fieldset>

      {weightColumns.length > 0 && (
        <label className="field">
          <span className="field-label">Edge weight</span>
          <select
            className="control"
            value={options.weightColumn ?? ""}
            onChange={(e) => setOptions((o) => ({ ...o, weightColumn: e.target.value || null }))}
          >
            <option value="">None (every edge counts once)</option>
            {weightColumns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected.includes("louvain") && (
        <label className="field">
          <span className="field-label">Community resolution {options.resolution.toFixed(1)}</span>
          <input
            type="range"
            className="range"
            min={0.2}
            max={3}
            step={0.1}
            value={options.resolution}
            onChange={(e) => setOptions((o) => ({ ...o, resolution: Number(e.target.value) }))}
          />
        </label>
      )}

      {heavySelected && nodeCount > HEAVY_NODE_WARNING && (
        <p className="warn">
          Betweenness and closeness walk every pair of nodes. On {nodeCount} nodes they are
          estimated from a sample and can still take a while.
        </p>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || selected.length === 0}
          onClick={() => void run()}
        >
          {running ? "Computing…" : "Run"}
        </button>
        {computedColumns.length > 0 && (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={running}
            onClick={onClearComputed}
          >
            Clear results
          </button>
        )}
      </div>

      {error && <p className="warn">{error}</p>}

      {lastRun && !error && (
        <div className="compute-result">
          <p className="note">
            Done in {Math.round(lastRun.elapsedMs)}ms
            {lastRun.offMainThread ? "" : " on the main thread"}.
          </p>
          {lastRun.summary.modularity !== undefined && (
            <div className="metric-rows">
              <div className="metric-row">
                <span className="metric-name">Modularity</span>
                <span className="metric-value">{formatMetric(lastRun.summary.modularity)}</span>
              </div>
              <div className="metric-row">
                <span className="metric-name">Communities</span>
                <span className="metric-value">{lastRun.summary.communityCount}</span>
              </div>
            </div>
          )}
          {/* Saying "18 columns" is useless without saying where they went. */}
          {(
            [
              ["nodes", lastRun.nodeColumns],
              ["edges", lastRun.edgeColumns],
            ] as [EditTarget, string[]][]
          )
            .filter(([, columns]) => columns.length > 0)
            .map(([target, columns]) => (
              <button
                key={target}
                type="button"
                className="compute-written"
                onClick={() => onShowColumns(target)}
                title={`Open the ${target === "nodes" ? "Nodes" : "Edges"} table`}
              >
                <span className="compute-written-head">
                  {columns.length} new {target === "nodes" ? "node" : "edge"}{" "}
                  {columns.length === 1 ? "column" : "columns"} →
                </span>
                <span className="compute-columns">{columns.join(" · ")}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
