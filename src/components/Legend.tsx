import { useMemo, type ReactNode } from "react";
import type { Corner, Graph, GraphDoc, GraphStyle } from "../types";
import { styleColumn } from "../types";
import { findValueStep, type FilterStep } from "../lib/filter";
import { formatMetric } from "../lib/format";
import { useCornerDrag } from "../useCornerDrag";
import { MAX_GROUPS, NEUTRAL, OTHER_GROUP, SEQUENTIAL } from "../theme";

const RANK_LABELS: Record<string, string> = {
  "metric:degree": "Connections",
  "metric:betweenness": "Betweenness",
  "metric:closeness": "Closeness",
  "metric:eigenvector": "Eigenvector",
};

interface Entry {
  name: string;
  color: string;
  /** What a click filters to; null for a bucket that stands for several values. */
  value: string | null;
}

interface LegendProps {
  doc: GraphDoc;
  graph: Graph;
  style: GraphStyle;
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  chain: FilterStep[];
  corner: Corner;
  /** True when the controls are parked in the same corner; this one steps aside. */
  stacked: boolean;
  onCornerChange: (corner: Corner) => void;
  onToggleValueFilter: (table: "nodes" | "edges", column: string, value: string) => void;
  onHide: () => void;
}

/**
 * The color key, and a way into the filter chain: clicking an entry pins the
 * graph to that one value, clicking it again lets the rest back in. It rides
 * faint over the graph until it is hovered, so it stays out of the picture
 * while still saying what the colors mean, and it can be dragged into whichever
 * corner the graph is not using.
 */
export function Legend({
  doc,
  graph,
  style,
  colors,
  edgeColors,
  chain,
  corner,
  stacked,
  onCornerChange,
  onToggleValueFilter,
  onHide,
}: LegendProps) {
  const drag = useCornerDrag(corner, onCornerChange);

  const colorColumn = styleColumn(style.nodeColor);
  const edgeColorColumn = styleColumn(style.edgeColor);
  // Node colors from an attribute of the nodes are matched against the node
  // table; ones projected from the edges are matched against the rows they
  // came from, the same way the styling resolved them in the first place.
  const nodeTable =
    colorColumn !== null && doc.nodes.columns.some((c) => c.name === colorColumn)
      ? "nodes"
      : "edges";

  const nodeEntries = useMemo<Entry[]>(() => {
    if (graph.ranking || graph.groups.length === 0) return [];
    const entries: Entry[] = graph.groups.slice(0, MAX_GROUPS).map((g) => ({
      name: g,
      color: colors.get(g) ?? NEUTRAL,
      value: g,
    }));
    if (graph.groups.length > MAX_GROUPS) {
      entries.push({ name: OTHER_GROUP, color: NEUTRAL, value: null });
    }
    if (graph.nodes.some((n) => n.group === null)) {
      entries.push({ name: "Unassigned", color: NEUTRAL, value: null });
    }
    return entries;
  }, [graph, colors]);

  const edgeEntries = useMemo<Entry[]>(() => {
    const entries: Entry[] = graph.edgeGroups.slice(0, MAX_GROUPS).map((g) => ({
      name: g,
      color: edgeColors.get(g) ?? NEUTRAL,
      value: g,
    }));
    if (graph.edgeGroups.length > MAX_GROUPS) {
      entries.push({ name: OTHER_GROUP, color: NEUTRAL, value: null });
    }
    return entries;
  }, [graph, edgeColors]);

  const rankingLabel = RANK_LABELS[style.nodeColor] ?? colorColumn ?? "Value";

  const item = (
    key: string,
    entry: Entry,
    mark: ReactNode,
    table: "nodes" | "edges",
    column: string | null,
  ) => {
    if (entry.value === null || column === null) {
      return (
        <span key={key} className="legend-item">
          {mark}
          {entry.name}
        </span>
      );
    }
    const value = entry.value;
    const active = findValueStep(chain, table, column, value) !== undefined;
    return (
      <button
        key={key}
        type="button"
        className={active ? "legend-item legend-pick active" : "legend-item legend-pick"}
        onClick={() => onToggleValueFilter(table, column, value)}
        aria-pressed={active}
        title={active ? `Stop filtering to ${entry.name}` : `Filter down to ${entry.name}`}
      >
        {mark}
        {entry.name}
      </button>
    );
  };

  return (
    <div
      ref={drag.ref}
      className={`legend at-${corner}${stacked ? " stacked" : ""}${
        drag.dragging ? " dragging" : ""
      }`}
      aria-label="Legend"
      title="Drag into another corner"
      {...drag.handleProps}
    >
      {graph.ranking && (
        <span className="legend-item">
          <span
            className="legend-gradient"
            style={{ background: `linear-gradient(90deg, ${SEQUENTIAL.join(",")})` }}
          />
          <span>
            {rankingLabel} {formatMetric(graph.ranking.min)} to {formatMetric(graph.ranking.max)}
          </span>
        </span>
      )}
      {nodeEntries.map((e) =>
        item(
          `n${e.name}`,
          e,
          <span className="legend-dot" style={{ background: e.color }} />,
          nodeTable,
          colorColumn,
        ),
      )}
      {edgeEntries.length > 0 && edgeColorColumn && (
        <span className="legend-item legend-caption">{edgeColorColumn}:</span>
      )}
      {edgeEntries.map((e) =>
        item(
          `e${e.name}`,
          e,
          <span className="legend-line" style={{ background: e.color }} />,
          "edges",
          edgeColorColumn,
        ),
      )}
      <button
        type="button"
        className="overlay-x"
        onClick={onHide}
        title="Hide the legend"
        aria-label="Hide the legend"
      >
        ×
      </button>
    </div>
  );
}
