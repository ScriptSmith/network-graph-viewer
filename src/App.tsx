import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import type { CellValue, Dataset, GraphDoc, GraphStyle, LabelMode, Mapping } from "./types";
import { DEFAULT_STYLE, styleColumn } from "./types";
import { SAMPLE_DATASET } from "./sample-data";
import { ACCEPTED_EXTENSIONS, parseFile, guessStyle } from "./lib/parse";
import {
  detectFormat,
  downloadText,
  exportAs,
  extractGistFileHint,
  extractGistId,
  fetchGist,
  matchesFileHint,
  parseText,
  TEXT_EXTENSIONS,
  type ExportFormat,
  type ImportedGraph,
  type Position,
} from "./lib/io";
import { applyComputedColumns, buildDoc, clearComputedColumns, reconcileNodes } from "./lib/doc";
import { applyStyle, buildBaseGraph } from "./lib/graph";
import { applyChain, newStepId, type FilterStep } from "./lib/filter";
import { defaultParams, type LayoutId, type LayoutParams, type ParamValue } from "./lib/layouts";
import { addRow, deleteRows, setCell, type EditTarget } from "./lib/edit";
import { toMetricGraph, type MetricOptions } from "./lib/metrics";
import { computeMetrics, runScriptInWorker } from "./lib/metrics/runner";
import { interpretResult, normalizeEdgeKeys, toScriptGraph } from "./lib/script/payload";
import type { ScriptRunRequest } from "./components/ScriptPanel";
import { downloadPng, downloadSvg } from "./lib/export";
import { groupColorMap, MAX_GROUPS, NEUTRAL, OTHER_GROUP, SEQUENTIAL } from "./theme";
import { formatMetric } from "./lib/format";
import { usePanelSize, type PanelSizeOptions } from "./usePanelSize";
import { GraphCanvas, type GraphCanvasHandle } from "./components/GraphCanvas";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { StatsPanel } from "./components/StatsPanel";
import { TableDrawer } from "./components/TableDrawer";

const AMBIENT_TABLE = SAMPLE_DATASET.tables[0];
const AMBIENT_DOC = buildDoc(SAMPLE_DATASET.fileName, AMBIENT_TABLE);
const AMBIENT_STYLE: GraphStyle = guessStyle(AMBIENT_TABLE, AMBIENT_DOC.mapping);
const AMBIENT_GRAPH = applyStyle(buildBaseGraph(AMBIENT_DOC), AMBIENT_DOC, AMBIENT_STYLE);
const AMBIENT_COLORS = groupColorMap(AMBIENT_GRAPH.groups);

/**
 * Everything the stage draws on top of the graph. Each one can be dismissed on
 * its own, and "Show all" puts every one of them back. "panels" covers the
 * stats and inspector overlays, which are only ever hidden all at once: they
 * already carry their own close buttons. The data pane is not here; like the
 * sidebar it takes its own room rather than covering the graph.
 */
const OVERLAYS = ["toolbar", "legend", "count", "panels"] as const;
type Overlay = (typeof OVERLAYS)[number];

const SIDEBAR_SIZE: PanelSizeOptions = {
  storageKey: "ngv:sidebar-width",
  axis: "x",
  fallback: 316,
  min: 250,
  max: () => 680,
};

const DRAWER_SIZE: PanelSizeOptions = {
  storageKey: "ngv:drawer-height",
  axis: "y",
  fallback: 200,
  min: 120,
  // Whatever the window allows, less enough graph to still aim at.
  max: () => Math.max(120, window.innerHeight - 160),
};

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [edgeTableIndex, setEdgeTableIndex] = useState(0);
  const [nodeTableIndex, setNodeTableIndex] = useState<number | null>(null);
  const [doc, setDoc] = useState<GraphDoc | null>(null);
  const [style, setStyle] = useState<GraphStyle>(DEFAULT_STYLE);
  const [chain, setChain] = useState<FilterStep[]>([]);
  const [showIsolated, setShowIsolated] = useState(false);
  const [layout, setLayout] = useState<LayoutId>("force");
  // Parameters are kept per layout so switching away and back is lossless.
  const [paramsByLayout, setParamsByLayout] = useState<Partial<Record<LayoutId, LayoutParams>>>({});
  const [preventOverlap, setPreventOverlap] = useState(false);
  // Positions from a layout script, used as targets by the "script" layout.
  const [scriptedTargets, setScriptedTargets] = useState<Map<string, Position> | null>(null);
  const [labelMode, setLabelMode] = useState<LabelMode>("auto");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [tableTab, setTableTab] = useState<EditTarget>("edges");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Overlays the user has dismissed, so the graph can be presented or
  // screenshotted clean. Nothing underneath changes: showing them again brings
  // each one back as it was.
  const [hiddenOverlays, setHiddenOverlays] = useState<ReadonlySet<Overlay>>(() => new Set());
  // Both panels are only ever hidden with CSS, never unmounted, so a collapse
  // does not throw away a half-written script, an unsaved gist token, or the
  // search and grouping set up over the table.
  const { size: sidebarWidth, handleProps: sidebarHandle } = usePanelSize(SIDEBAR_SIZE);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { size: drawerHeight, handleProps: drawerHandle } = usePanelSize(DRAWER_SIZE);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);

  const canvasRef = useRef<GraphCanvasHandle>(null);
  // Positions handed to the canvas on its next rebuild: a node just dropped,
  // or a whole layout that arrived with an imported file.
  const seedPositionsRef = useRef<Map<string, Position> | null>(null);

  const chained = useMemo(
    () => (doc ? applyChain(doc, chain, { showIsolated }) : null),
    [doc, chain, showIsolated],
  );
  const base = chained?.graph ?? null;
  const filteredRows = base?.rows ?? [];
  const graph = useMemo(
    () => (base && doc ? applyStyle(base, doc, style) : null),
    [base, doc, style],
  );
  const colors = useMemo(
    () => (graph ? groupColorMap(graph.groups) : new Map<string, string>()),
    [graph],
  );
  const edgeColors = useMemo(
    () => (graph ? groupColorMap(graph.edgeGroups) : new Map<string, string>()),
    [graph],
  );

  const adoptDoc = useCallback((next: GraphDoc, nextStyle: GraphStyle) => {
    setDoc(next);
    setStyle(nextStyle);
    setChain([]);
    setShowIsolated(next.nodesDeclared);
    setSelectedId(null);
    setError(null);
  }, []);

  const adoptImported = useCallback(
    (imported: ImportedGraph & { workspace?: import("./lib/io").Workspace }) => {
      const { doc: next, positions, workspace } = imported;
      setDataset(null);
      setEdgeTableIndex(0);
      setNodeTableIndex(null);
      seedPositionsRef.current = positions ?? null;
      setDoc(next);
      setStyle(workspace?.style ?? guessStyle(next.edges, next.mapping));
      setChain(workspace?.chain ?? []);
      setShowIsolated(workspace?.showIsolated ?? next.nodesDeclared);
      if (workspace) {
        setLayout(workspace.layout);
        setParamsByLayout((current) => ({
          ...current,
          [workspace.layout]: workspace.layoutParams,
        }));
        setPreventOverlap(workspace.preventOverlap);
      }
      setSelectedId(null);
      setError(null);
    },
    [],
  );

  const adoptDataset = useCallback(
    (next: Dataset) => {
      const edges = next.tables[0];
      const nextDoc = buildDoc(next.fileName, edges);
      setDataset(next);
      setEdgeTableIndex(0);
      setNodeTableIndex(null);
      adoptDoc(nextDoc, guessStyle(edges, nextDoc.mapping));
    },
    [adoptDoc],
  );

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const lowered = file.name.toLowerCase();
        if (TEXT_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
          const text = await file.text();
          const imported = await parseText(text, file.name);
          if (imported.dataset) adoptDataset(imported.dataset);
          else adoptImported(imported);
          return;
        }
        adoptDataset(await parseFile(file));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that file.");
      }
    },
    [adoptDataset, adoptImported],
  );

  // Cells copied in Excel or Google Sheets arrive as tab-separated text, so
  // pasting anywhere outside a form control loads them like a dropped file.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim()) {
        e.preventDefault();
        void (async () => {
          try {
            const imported = await parseText(text, "Pasted data");
            if (imported.dataset) adoptDataset(imported.dataset);
            else adoptImported(imported);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not read the pasted cells.");
          }
        })();
        return;
      }
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)),
      );
      if (file) {
        e.preventDefault();
        void handleFile(file);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [adoptDataset, adoptImported, handleFile]);

  const hideOverlay = useCallback((key: Overlay) => {
    setHiddenOverlays((current) => new Set(current).add(key));
  }, []);

  const hideAllOverlays = useCallback(() => setHiddenOverlays(new Set(OVERLAYS)), []);

  const showAllOverlays = useCallback(() => {
    setHiddenOverlays((current) => (current.size === 0 ? current : new Set()));
  }, []);

  // H clears the stage or puts it back; Escape only ever puts it back, so the
  // way out is never hidden along with everything else.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      if (e.key === "h" || e.key === "H") {
        setHiddenOverlays((current) => (current.size > 0 ? new Set() : new Set(OVERLAYS)));
      } else if (e.key === "Escape") {
        setHiddenOverlays((current) => (current.size === 0 ? current : new Set()));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSample = useCallback(() => adoptDataset(SAMPLE_DATASET), [adoptDataset]);

  /**
   * Load a gist by id or URL. Multi-file gists pick the first file that looks
   * like a graph, unless the URL's #file- fragment named one.
   */
  const handleGist = useCallback(
    async (reference: string) => {
      const id = extractGistId(reference);
      if (id === null) {
        setError("That does not look like a gist URL or id.");
        return;
      }
      setError(null);
      try {
        const gist = await fetchGist(id);
        const hint = extractGistFileHint(reference);
        const hinted = hint ? gist.files.find((f) => matchesFileHint(f.name, hint)) : undefined;
        const file =
          hinted ??
          gist.files.find((f) => detectFormat(f.name, f.content) !== "delimited") ??
          gist.files[0];
        const imported = await parseText(file.content, file.name);
        if (imported.dataset) adoptDataset(imported.dataset);
        else adoptImported(imported);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load that gist.");
      }
    },
    [adoptDataset, adoptImported],
  );

  // A ?gist= link loads straight away; only gists, so a crafted link cannot
  // point the browser at an arbitrary host.
  const gistLoaded = useRef(false);
  useEffect(() => {
    if (gistLoaded.current) return;
    const reference = new URLSearchParams(window.location.search).get("gist");
    if (!reference) return;
    gistLoaded.current = true;
    void handleGist(reference);
  }, [handleGist]);

  const handleClear = useCallback(() => {
    setDataset(null);
    setEdgeTableIndex(0);
    setNodeTableIndex(null);
    setDoc(null);
    setStyle(DEFAULT_STYLE);
    setChain([]);
    setShowIsolated(false);
    setSelectedId(null);
    setStatsOpen(false);
    setDrawerCollapsed(false);
    setHiddenOverlays(new Set());
    setError(null);
  }, []);

  /** Rebuild the document from a different pair of imported tables. */
  const handleTableChange = useCallback(
    (edgeIndex: number, nodeIndex: number | null) => {
      if (!dataset) return;
      const edges = dataset.tables[edgeIndex];
      const nodes = nodeIndex === null ? undefined : dataset.tables[nodeIndex];
      const nextDoc = buildDoc(dataset.fileName, edges, { nodes });
      setEdgeTableIndex(edgeIndex);
      setNodeTableIndex(nodeIndex);
      adoptDoc(nextDoc, guessStyle(edges, nextDoc.mapping));
    },
    [dataset, adoptDoc],
  );

  const handleMappingChange = useCallback(
    (patch: Partial<Mapping>) => {
      if (!doc) return;
      const mapping = { ...doc.mapping, ...patch };
      mapping.attrs = mapping.attrs.filter((c) => c !== mapping.source && c !== mapping.target);
      setDoc((current) => (current ? reconcileNodes({ ...current, mapping }) : current));
      // Style choices that now point at a structural column stop making sense.
      setStyle((s) => {
        const fix = (token: string, fallback: string) => {
          const col = styleColumn(token);
          return col === mapping.source || col === mapping.target ? fallback : token;
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
    [doc],
  );

  const handleStyleChange = useCallback((patch: Partial<GraphStyle>) => {
    setStyle((s) => ({ ...s, ...patch }));
  }, []);

  const layoutParams = useMemo(
    () => ({ ...defaultParams(layout), ...paramsByLayout[layout] }),
    [layout, paramsByLayout],
  );

  const handleLayoutParamChange = useCallback(
    (key: string, value: ParamValue) => {
      setParamsByLayout((current) => ({
        ...current,
        [layout]: { ...defaultParams(layout), ...current[layout], [key]: value },
      }));
    },
    [layout],
  );

  /**
   * Metrics run over the graph as currently filtered, matching what the user
   * can see, and land in the document as computed columns.
   */
  const handleCompute = useCallback(
    async (metrics: string[], options: MetricOptions) => {
      if (!base) throw new Error("Load data before computing metrics.");
      const run = await computeMetrics(toMetricGraph(base, options.weightColumn), metrics, options);
      setDoc((current) => (current ? applyComputedColumns(current, run.result) : current));
      return run;
    },
    [base],
  );

  const handleEditCell = useCallback(
    (target: EditTarget, rowIndex: number, column: string, value: CellValue) => {
      setDoc((current) => (current ? setCell(current, target, rowIndex, column, value) : current));
    },
    [],
  );

  const handleAddRow = useCallback((target: EditTarget) => {
    setDoc((current) => (current ? addRow(current, target) : current));
    if (target === "nodes") setShowIsolated(true);
  }, []);

  const handleDeleteRow = useCallback((target: EditTarget, rowIndex: number) => {
    setDoc((current) => (current ? deleteRows(current, target, [rowIndex]) : current));
  }, []);

  /**
   * Run a user script and route its result: a metric becomes a computed column
   * like any built-in one, a layout becomes the targets the canvas morphs to.
   */
  const handleScript = useCallback(
    async ({ code, mode, column }: ScriptRunRequest) => {
      if (!base || !doc) throw new Error("Load data before running a script.");
      const { result, elapsedMs } = await runScriptInWorker(code, toScriptGraph(base, doc));
      const outcome = interpretResult(mode, result);

      if (mode === "layout") {
        const positions = new Map(Object.entries(outcome.positions ?? {}));
        setScriptedTargets(positions);
        setLayout("script");
        return `Placed ${positions.size} nodes in ${Math.round(elapsedMs)}ms.`;
      }

      const name = column.trim();
      const values =
        mode === "edge" ? normalizeEdgeKeys(outcome.values ?? {}) : (outcome.values ?? {});
      const runResult = {
        nodeColumns: mode === "node" ? [{ name, type: "number" as const, values }] : [],
        edgeColumns: mode === "edge" ? [{ name, type: "number" as const, values }] : [],
        summary: {},
      };
      setDoc((current) => (current ? applyComputedColumns(current, runResult) : current));
      // Send the user where the column actually landed.
      setTableTab(mode === "edge" ? "edges" : "nodes");
      return `Wrote "${name}" over ${Object.keys(values).length} rows in ${Math.round(elapsedMs)}ms.`;
    },
    [base, doc],
  );

  const handleClearComputed = useCallback(() => {
    setDoc((current) => (current ? clearComputedColumns(current) : current));
  }, []);

  /** Open the data table on whichever tab holds the columns just written. */
  const handleShowColumns = useCallback((target: EditTarget) => {
    setTableTab(target);
    setDrawerCollapsed(false);
  }, []);

  /** Clicking a breakdown bar drops a one-value column step onto the chain. */
  const handleToggleValueFilter = useCallback((column: string, value: string) => {
    setChain((current) => {
      const existing = current.find(
        (s) =>
          s.kind === "column" &&
          s.table === "edges" &&
          s.column === column &&
          s.op.kind === "values" &&
          s.op.selected.length === 1 &&
          s.op.selected[0] === value,
      );
      if (existing) return current.filter((s) => s.id !== existing.id);
      return [
        ...current,
        {
          id: newStepId(),
          enabled: true,
          kind: "column",
          table: "edges",
          column,
          op: { kind: "values", selected: [value] },
        },
      ];
    });
  }, []);

  const exportInput = useCallback(() => {
    if (!doc) return null;
    return {
      doc,
      graph,
      style,
      colors,
      chain,
      layout,
      layoutParams,
      showIsolated,
      preventOverlap,
    };
  }, [doc, graph, style, colors, chain, layout, layoutParams, showIsolated, preventOverlap]);

  const handleExportData = useCallback(
    (format: ExportFormat) => {
      const input = exportInput();
      if (!input) return;
      try {
        downloadText(exportAs(format, input));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Export failed.");
      }
    },
    [exportInput],
  );

  const handleExport = useCallback(
    async (format: "svg" | "png") => {
      const result = canvasRef.current?.buildExport();
      if (!result || !doc) return;
      const base = `${doc.name.replace(/\.[^.]+$/, "")}-graph`;
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
    [doc],
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

  const visibleRows = useMemo(() => new Set(base?.rows ?? []), [base]);
  const visibleNodeIds = useMemo(() => new Set((base?.nodes ?? []).map((n) => n.id)), [base]);

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
      className={`app${sidebarCollapsed ? " app-collapsed" : ""}${
        drawerCollapsed ? " app-drawer-collapsed" : ""
      }`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--drawer-height": `${drawerHeight}px`,
        } as CSSProperties
      }
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
        edgeTableIndex={edgeTableIndex}
        nodeTableIndex={nodeTableIndex}
        doc={doc}
        style={style}
        chain={chain}
        chainResults={chained?.steps ?? []}
        graph={graph}
        selectedId={selectedId}
        showIsolated={showIsolated}
        layout={layout}
        layoutParams={layoutParams}
        preventOverlap={preventOverlap}
        labelMode={labelMode}
        onFile={(f) => void handleFile(f)}
        onSample={handleSample}
        onClear={handleClear}
        onTableChange={handleTableChange}
        onMappingChange={handleMappingChange}
        onStyleChange={handleStyleChange}
        onChainChange={setChain}
        onShowIsolatedChange={setShowIsolated}
        onCompute={handleCompute}
        onClearComputed={handleClearComputed}
        onShowColumns={handleShowColumns}
        onScript={handleScript}
        onLayoutChange={setLayout}
        onLayoutParamChange={handleLayoutParamChange}
        onPreventOverlapChange={setPreventOverlap}
        onSeparate={() => canvasRef.current?.separate()}
        onLabelModeChange={setLabelMode}
        onExport={(f) => void handleExport(f)}
        onExportData={handleExportData}
        onGist={(reference) => void handleGist(reference)}
        exportInput={exportInput}
      />

      <div className="resizer" aria-label="Sidebar width" {...sidebarHandle} />

      {/* One control in one place: it rides the sidebar's edge, so collapsing
          and expanding happen wherever that edge currently is. */}
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setSidebarCollapsed((v) => !v)}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"}
        aria-label={sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"}
      >
        <span aria-hidden="true">{sidebarCollapsed ? "›" : "‹"}</span>
      </button>

      {/* The same control on the data pane's edge, turned a quarter turn. */}
      {doc && (
        <button
          type="button"
          className="drawer-toggle"
          onClick={() => setDrawerCollapsed((v) => !v)}
          aria-expanded={!drawerCollapsed}
          title={drawerCollapsed ? "Show the data table" : "Hide the data table"}
          aria-label={drawerCollapsed ? "Show the data table" : "Hide the data table"}
        >
          <span aria-hidden="true">{drawerCollapsed ? "‹" : "›"}</span>
        </button>
      )}

      <div className="workspace">
        <main className="stage">
          {graph && doc ? (
            <>
              <GraphCanvas
                ref={canvasRef}
                graph={graph}
                layout={layout}
                layoutParams={layoutParams}
                scriptedTargets={scriptedTargets}
                preventOverlap={preventOverlap}
                labelMode={labelMode}
                style={style}
                colors={colors}
                edgeColors={edgeColors}
                attrColumns={doc.mapping.attrs}
                selectedId={selectedId}
                onSelect={setSelectedId}
                seedPositions={seedPositionsRef}
              />
              {hiddenOverlays.has("toolbar") && (
                <button
                  type="button"
                  className="tool-btn chrome-restore"
                  onClick={showAllOverlays}
                  title="Bring back everything that is hidden (H)"
                >
                  Show controls
                </button>
              )}
              {!hiddenOverlays.has("toolbar") && (
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
                  {hiddenOverlays.size > 0 && (
                    <button
                      type="button"
                      className="tool-btn"
                      onClick={showAllOverlays}
                      title="Bring back everything that is hidden (H)"
                    >
                      Show controls
                    </button>
                  )}
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={hideAllOverlays}
                    title="Hide everything drawn over the graph (H)"
                  >
                    Hide controls
                  </button>
                  <button
                    type="button"
                    className="overlay-x"
                    onClick={() => hideOverlay("toolbar")}
                    title="Hide these buttons"
                    aria-label="Hide these buttons"
                  >
                    ×
                  </button>
                </div>
              )}
              {showLegend && !hiddenOverlays.has("legend") && (
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
                  <button
                    type="button"
                    className="overlay-x"
                    onClick={() => hideOverlay("legend")}
                    title="Hide the legend"
                    aria-label="Hide the legend"
                  >
                    ×
                  </button>
                </div>
              )}
              {!hiddenOverlays.has("count") && (
                <div className="status-chip">
                  {graph.nodes.length} nodes · {graph.links.length} edges
                  <button
                    type="button"
                    className="overlay-x"
                    onClick={() => hideOverlay("count")}
                    title="Hide the node and edge count"
                    aria-label="Hide the node and edge count"
                  >
                    ×
                  </button>
                </div>
              )}
              {graph.nodes.length === 0 && (
                <div className="no-match">
                  <p>No rows match the current filters.</p>
                </div>
              )}
              {statsOpen && !hiddenOverlays.has("panels") && (
                <StatsPanel
                  doc={doc}
                  rows={filteredRows}
                  totalRows={doc.edges.rows.length}
                  graph={graph}
                  colorColumn={graph.ranking ? null : colorColumn}
                  colors={colors}
                  chain={chain}
                  onToggleValueFilter={handleToggleValueFilter}
                  onSelectNode={setSelectedId}
                  onClose={() => setStatsOpen(false)}
                />
              )}
              {selectedId && !statsOpen && !hiddenOverlays.has("panels") && (
                <Inspector
                  doc={doc}
                  graph={graph}
                  selectedId={selectedId}
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
                layoutParams={{}}
                preventOverlap={false}
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
                    Upload an edge list, one row per connection: the first two columns you map
                    become the arrows, everything else becomes detail you can style, filter, and
                    chart.
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
                  <p className="example-caption">
                    Or copy cells in Excel or Google Sheets and paste them here (Ctrl+V or ⌘V).
                  </p>
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

        {doc && (
          <TableDrawer
            doc={doc}
            target={tableTab}
            onTargetChange={setTableTab}
            visibleRows={visibleRows}
            visibleNodeIds={visibleNodeIds}
            selectedId={selectedId}
            onSelectNode={setSelectedId}
            onEditCell={handleEditCell}
            onAddRow={handleAddRow}
            onDeleteRow={handleDeleteRow}
            gripProps={drawerHandle}
          />
        )}
      </div>
    </div>
  );
}
