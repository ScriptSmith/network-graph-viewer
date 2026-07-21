import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import type { Dataset, Filters, GraphStyle, LabelMode, LayoutId, Mapping } from "./types";
import { DEFAULT_STYLE, styleColumn } from "./types";
import { SAMPLE_DATASET } from "./sample-data";
import { parseFile, guessMapping, guessStyle } from "./lib/parse";
import { applyFilters, buildGraph } from "./lib/graph";
import { downloadPng, downloadSvg } from "./lib/export";
import { groupColorMap, MAX_GROUPS, NEUTRAL, OTHER_GROUP, SEQUENTIAL } from "./theme";
import { formatMetric } from "./lib/format";
import { GraphCanvas, type GraphCanvasHandle } from "./components/GraphCanvas";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { StatsPanel } from "./components/StatsPanel";

const AMBIENT_SHEET = SAMPLE_DATASET.sheets[0];
const AMBIENT_MAPPING: Mapping = guessMapping(AMBIENT_SHEET);
const AMBIENT_STYLE: GraphStyle = guessStyle(AMBIENT_SHEET, AMBIENT_MAPPING);
const AMBIENT_GRAPH = buildGraph(AMBIENT_SHEET.rows, AMBIENT_MAPPING, AMBIENT_STYLE);
const AMBIENT_COLORS = groupColorMap(AMBIENT_GRAPH.groups);

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [style, setStyle] = useState<GraphStyle>(DEFAULT_STYLE);
  const [filters, setFilters] = useState<Filters>({});
  const [layout, setLayout] = useState<LayoutId>("force");
  const [labelMode, setLabelMode] = useState<LabelMode>("auto");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const canvasRef = useRef<GraphCanvasHandle>(null);

  const sheet = dataset?.sheets[sheetIndex] ?? null;

  const filteredRows = useMemo(
    () => (sheet ? applyFilters(sheet.rows, filters) : []),
    [sheet, filters],
  );

  const graph = useMemo(
    () => (sheet && mapping ? buildGraph(filteredRows, mapping, style) : null),
    [sheet, mapping, filteredRows, style],
  );
  const colors = useMemo(
    () => (graph ? groupColorMap(graph.groups) : new Map<string, string>()),
    [graph],
  );
  const edgeColors = useMemo(
    () => (graph ? groupColorMap(graph.edgeGroups) : new Map<string, string>()),
    [graph],
  );

  const adoptDataset = useCallback((next: Dataset) => {
    const firstSheet = next.sheets[0];
    const nextMapping = guessMapping(firstSheet);
    setDataset(next);
    setSheetIndex(0);
    setMapping(nextMapping);
    setStyle(guessStyle(firstSheet, nextMapping));
    setFilters({});
    setSelectedId(null);
    setError(null);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        adoptDataset(await parseFile(file));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that file.");
      }
    },
    [adoptDataset],
  );

  const handleSample = useCallback(() => adoptDataset(SAMPLE_DATASET), [adoptDataset]);

  const handleClear = useCallback(() => {
    setDataset(null);
    setMapping(null);
    setStyle(DEFAULT_STYLE);
    setFilters({});
    setSelectedId(null);
    setStatsOpen(false);
    setError(null);
  }, []);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (!dataset) return;
      const nextSheet = dataset.sheets[index];
      const nextMapping = guessMapping(nextSheet);
      setSheetIndex(index);
      setMapping(nextMapping);
      setStyle(guessStyle(nextSheet, nextMapping));
      setFilters({});
      setSelectedId(null);
    },
    [dataset],
  );

  const handleMappingChange = useCallback(
    (patch: Partial<Mapping>) => {
      if (!mapping) return;
      const next = { ...mapping, ...patch };
      next.attrs = next.attrs.filter((c) => c !== next.source && c !== next.target);
      setMapping(next);
      // Style choices that now point at a structural column stop making sense.
      setStyle((s) => {
        const fix = (token: string, fallback: string) => {
          const col = styleColumn(token);
          return col === next.source || col === next.target ? fallback : token;
        };
        return {
          ...s,
          nodeColor: fix(s.nodeColor, "none"),
          nodeSize: fix(s.nodeSize, "metric:degree"),
          edgeWidth: fix(s.edgeWidth, "uniform"),
          edgeColor: fix(s.edgeColor, "uniform"),
        };
      });
    },
    [mapping],
  );

  const handleStyleChange = useCallback((patch: Partial<GraphStyle>) => {
    setStyle((s) => ({ ...s, ...patch }));
  }, []);

  const handleToggleValueFilter = useCallback((column: string, value: string) => {
    setFilters((f) => {
      const current = f[column];
      const next = { ...f };
      if (
        current?.kind === "values" &&
        current.selected.length === 1 &&
        current.selected[0] === value
      ) {
        delete next[column];
      } else {
        next[column] = { kind: "values", selected: [value] };
      }
      return next;
    });
  }, []);

  const handleExport = useCallback(
    async (format: "svg" | "png") => {
      const result = canvasRef.current?.buildExport();
      if (!result || !dataset) return;
      const base = `${dataset.fileName.replace(/\.[^.]+$/, "")}-graph`;
      try {
        if (format === "svg") {
          downloadSvg(result.svgText, base);
        } else {
          await downloadPng(result.svgText, result.box, base);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Export failed.");
      }
    },
    [dataset],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const colorColumn = styleColumn(style.nodeColor);
  const edgeColorColumn = styleColumn(style.edgeColor);

  const nodeLegend = useMemo(() => {
    if (!graph || graph.ranking || graph.groups.length === 0) return [];
    const entries = graph.groups.slice(0, MAX_GROUPS).map((g) => ({
      name: g,
      color: colors.get(g) ?? NEUTRAL,
    }));
    if (graph.groups.length > MAX_GROUPS) entries.push({ name: OTHER_GROUP, color: NEUTRAL });
    if (graph.nodes.some((n) => n.group === null)) {
      entries.push({ name: "Unassigned", color: NEUTRAL });
    }
    return entries;
  }, [graph, colors]);

  const edgeLegend = useMemo(() => {
    if (!graph || graph.edgeGroups.length === 0) return [];
    const entries = graph.edgeGroups.slice(0, MAX_GROUPS).map((g) => ({
      name: g,
      color: edgeColors.get(g) ?? NEUTRAL,
    }));
    if (graph.edgeGroups.length > MAX_GROUPS) entries.push({ name: OTHER_GROUP, color: NEUTRAL });
    return entries;
  }, [graph, edgeColors]);

  const RANK_LABELS: Record<string, string> = {
    "metric:degree": "Connections",
    "metric:betweenness": "Betweenness",
    "metric:closeness": "Closeness",
    "metric:eigenvector": "Eigenvector",
  };
  const rankingLabel = RANK_LABELS[style.nodeColor] ?? colorColumn ?? "Value";

  const showLegend =
    graph !== null && (nodeLegend.length > 0 || edgeLegend.length > 0 || graph.ranking !== null);

  const pickAnyFile = () => {
    document.querySelector<HTMLInputElement>("input[type=file]")?.click();
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <Sidebar
        dataset={dataset}
        sheetIndex={sheetIndex}
        sheet={sheet}
        mapping={mapping}
        style={style}
        filters={filters}
        graph={graph}
        filteredRowCount={filteredRows.length}
        layout={layout}
        labelMode={labelMode}
        onFile={(f) => void handleFile(f)}
        onSample={handleSample}
        onClear={handleClear}
        onSheetChange={handleSheetChange}
        onMappingChange={handleMappingChange}
        onStyleChange={handleStyleChange}
        onFiltersChange={setFilters}
        onLayoutChange={setLayout}
        onLabelModeChange={setLabelMode}
        onExport={(f) => void handleExport(f)}
      />

      <main className="stage">
        {graph && mapping ? (
          <>
            <GraphCanvas
              ref={canvasRef}
              graph={graph}
              layout={layout}
              labelMode={labelMode}
              style={style}
              colors={colors}
              edgeColors={edgeColors}
              attrColumns={mapping.attrs}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <div className="toolbar">
              <button
                type="button"
                className="tool-btn"
                onClick={() => canvasRef.current?.fit()}
                title="Fit graph to view"
              >
                Fit
              </button>
              <button
                type="button"
                className="tool-btn"
                onClick={() => canvasRef.current?.reheat()}
                title="Re-run the layout"
              >
                Re-run
              </button>
              <button
                type="button"
                className={statsOpen ? "tool-btn active" : "tool-btn"}
                onClick={() => setStatsOpen((v) => !v)}
                aria-pressed={statsOpen}
                title="Show graph statistics"
              >
                Stats
              </button>
            </div>
            {showLegend && (
              <div className="legend" aria-label="Legend">
                {graph.ranking && (
                  <span className="legend-item">
                    <span
                      className="legend-gradient"
                      style={{ background: `linear-gradient(90deg, ${SEQUENTIAL.join(",")})` }}
                    />
                    <span>
                      {rankingLabel} {formatMetric(graph.ranking.min)} to{" "}
                      {formatMetric(graph.ranking.max)}
                    </span>
                  </span>
                )}
                {nodeLegend.map((e) => (
                  <span key={`n${e.name}`} className="legend-item">
                    <span className="legend-dot" style={{ background: e.color }} />
                    {e.name}
                  </span>
                ))}
                {edgeLegend.length > 0 && edgeColorColumn && (
                  <span className="legend-item legend-caption">{edgeColorColumn}:</span>
                )}
                {edgeLegend.map((e) => (
                  <span key={`e${e.name}`} className="legend-item">
                    <span className="legend-line" style={{ background: e.color }} />
                    {e.name}
                  </span>
                ))}
              </div>
            )}
            <div className="status-chip">
              {graph.nodes.length} nodes · {graph.links.length} edges
            </div>
            {graph.nodes.length === 0 && (
              <div className="no-match">
                <p>No rows match the current filters.</p>
              </div>
            )}
            {statsOpen && sheet && (
              <StatsPanel
                rows={filteredRows}
                totalRows={sheet.rows.length}
                graph={graph}
                mapping={mapping}
                colorColumn={graph.ranking ? null : colorColumn}
                colors={colors}
                filters={filters}
                onToggleValueFilter={handleToggleValueFilter}
                onSelectNode={setSelectedId}
                onClose={() => setStatsOpen(false)}
              />
            )}
            {selectedId && !statsOpen && (
              <Inspector
                graph={graph}
                selectedId={selectedId}
                attrColumns={mapping.attrs}
                colors={colors}
                onSelect={setSelectedId}
                onClose={() => setSelectedId(null)}
              />
            )}
          </>
        ) : (
          <>
            <GraphCanvas
              graph={AMBIENT_GRAPH}
              layout="force"
              labelMode="none"
              style={AMBIENT_STYLE}
              colors={AMBIENT_COLORS}
              edgeColors={new Map()}
              attrColumns={[]}
              selectedId={null}
              onSelect={() => {}}
              ambient
            />
            <div className="empty">
              <div className="empty-card">
                <h2 className="empty-title">Every spreadsheet hides a network.</h2>
                <p className="empty-tag">
                  Upload an edge list, one row per connection: the first two columns you map become
                  the arrows, everything else becomes detail you can style, filter, and chart.
                </p>
                <table className="example-table">
                  <thead>
                    <tr>
                      <th>Supervisor</th>
                      <th>Supervisee</th>
                      <th>Meetings</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Alex Rivera</td>
                      <td>Priya Sharma</td>
                      <td>4</td>
                    </tr>
                    <tr>
                      <td>Priya Sharma</td>
                      <td>Grace Okafor</td>
                      <td>4</td>
                    </tr>
                    <tr>
                      <td>Grace Okafor</td>
                      <td>Mei Chen</td>
                      <td>2</td>
                    </tr>
                  </tbody>
                </table>
                <p className="example-caption">
                  Any column names work; you pick which is which after loading.
                </p>
                <button type="button" className="dropzone" onClick={pickAnyFile}>
                  <strong>Drop a file here or click to browse</strong>
                  <span className="hint">.csv · .xlsx · .xls · .ods</span>
                </button>
                <button type="button" className="btn btn-primary" onClick={handleSample}>
                  Try the sample supervision network
                </button>
              </div>
            </div>
          </>
        )}
        {error && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {dragOver && <div className="drop-veil">Drop to load</div>}
      </main>
    </div>
  );
}
