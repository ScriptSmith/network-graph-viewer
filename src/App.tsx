import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import type { Dataset, LabelMode, LayoutId, Mapping } from "./types";
import { SAMPLE_DATASET } from "./sample-data";
import { parseFile, guessMapping } from "./lib/parse";
import { buildGraph } from "./lib/graph";
import { downloadPng, downloadSvg } from "./lib/export";
import { groupColorMap, MAX_GROUPS, NEUTRAL, OTHER_GROUP } from "./theme";
import { GraphCanvas, type GraphCanvasHandle } from "./components/GraphCanvas";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";

const AMBIENT_SHEET = SAMPLE_DATASET.sheets[0];
const AMBIENT_MAPPING: Mapping = guessMapping(AMBIENT_SHEET);
const AMBIENT_GRAPH = buildGraph(AMBIENT_SHEET.rows, AMBIENT_MAPPING);
const AMBIENT_COLORS = groupColorMap(AMBIENT_GRAPH.groups);

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [layout, setLayout] = useState<LayoutId>("force");
  const [labelMode, setLabelMode] = useState<LabelMode>("auto");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const canvasRef = useRef<GraphCanvasHandle>(null);

  const sheet = dataset?.sheets[sheetIndex] ?? null;

  const graph = useMemo(
    () => (sheet && mapping ? buildGraph(sheet.rows, mapping) : null),
    [sheet, mapping],
  );
  const colors = useMemo(
    () => (graph ? groupColorMap(graph.groups) : new Map<string, string>()),
    [graph],
  );

  const adoptDataset = useCallback((next: Dataset) => {
    setDataset(next);
    setSheetIndex(0);
    setMapping(guessMapping(next.sheets[0]));
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
    setSelectedId(null);
    setError(null);
  }, []);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (!dataset) return;
      setSheetIndex(index);
      setMapping(guessMapping(dataset.sheets[index]));
      setSelectedId(null);
    },
    [dataset],
  );

  const handleMappingChange = useCallback(
    (patch: Partial<Mapping>) => {
      if (!mapping) return;
      const next = { ...mapping, ...patch };
      // Keep the extras coherent when endpoints move.
      next.attrs = next.attrs.filter((c) => c !== next.source && c !== next.target);
      if (next.color === next.source || next.color === next.target) next.color = null;
      if (next.weight === next.source || next.weight === next.target) next.weight = null;
      setMapping(next);
    },
    [mapping],
  );

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

  const legendEntries = useMemo(() => {
    if (!graph || !mapping?.color || graph.groups.length === 0) return [];
    const entries = graph.groups.slice(0, MAX_GROUPS).map((g) => ({
      name: g,
      color: colors.get(g) ?? NEUTRAL,
    }));
    if (graph.groups.length > MAX_GROUPS) entries.push({ name: OTHER_GROUP, color: NEUTRAL });
    if (graph.nodes.some((n) => n.group === null)) {
      entries.push({ name: "Unassigned", color: NEUTRAL });
    }
    return entries;
  }, [graph, mapping, colors]);

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
        graph={graph}
        layout={layout}
        labelMode={labelMode}
        onFile={(f) => void handleFile(f)}
        onSample={handleSample}
        onClear={handleClear}
        onSheetChange={handleSheetChange}
        onMappingChange={handleMappingChange}
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
              colors={colors}
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
            </div>
            {legendEntries.length > 0 && (
              <div className="legend" aria-label="Node colors">
                {legendEntries.map((e) => (
                  <span key={e.name} className="legend-item">
                    <span className="legend-dot" style={{ background: e.color }} />
                    {e.name}
                  </span>
                ))}
              </div>
            )}
            <div className="status-chip">
              {graph.nodes.length} nodes · {graph.links.length} edges
            </div>
            {selectedId && (
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
              colors={AMBIENT_COLORS}
              attrColumns={[]}
              selectedId={null}
              onSelect={() => {}}
              ambient
            />
            <div className="empty">
              <div className="empty-card">
                <h2 className="empty-title">Every spreadsheet hides a network.</h2>
                <p className="empty-tag">
                  Upload an edge list (one row per connection), pick your columns, and explore it as
                  a living graph. Nothing leaves your browser.
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
