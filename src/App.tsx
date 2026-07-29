import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import type {
  CellValue,
  Dataset,
  GraphDoc,
  GraphStyle,
  LabelMode,
  Mapping,
  Corner,
  GraphSelection,
  Overlay,
  Panel,
} from "./types";
import { DEFAULT_STYLE, OVERLAYS, PANELS, nodeSelection, selectedNode, styleColumn } from "./types";
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
import { applyStyle, buildBaseGraph, hasLegend } from "./lib/graph";
import { applyChain, findValueStep, newStepId, type FilterStep } from "./lib/filter";
import { defaultParams, type LayoutId, type LayoutParams, type ParamValue } from "./lib/layouts";
import { addRow, deleteRows, setCell, type EditTarget } from "./lib/edit";
import { toMetricGraph, type MetricOptions } from "./lib/metrics";
import { computeMetrics, runScriptInWorker } from "./lib/metrics/runner";
import { interpretResult, normalizeEdgeKeys, toScriptGraph } from "./lib/script/payload";
import type { ScriptRunRequest } from "./components/ScriptPanel";
import { downloadPng, downloadSvg } from "./lib/export";
import { groupColorMap } from "./theme";
import { usePanelSize, type PanelSizeOptions } from "./usePanelSize";
import { useCornerDrag } from "./useCornerDrag";
import { useDocHistory } from "./useDocHistory";
import { GraphCanvas, type GraphCanvasHandle } from "./components/GraphCanvas";
import { Sidebar } from "./components/Sidebar";
import { StatsPanel } from "./components/StatsPanel";
import { TableDrawer } from "./components/TableDrawer";
import { Legend } from "./components/Legend";
import { ViewMenu } from "./components/ViewMenu";

const AMBIENT_TABLE = SAMPLE_DATASET.tables[0];
const AMBIENT_DOC = buildDoc(SAMPLE_DATASET.fileName, AMBIENT_TABLE);
const AMBIENT_STYLE: GraphStyle = guessStyle(AMBIENT_TABLE, AMBIENT_DOC.mapping);
const AMBIENT_GRAPH = applyStyle(buildBaseGraph(AMBIENT_DOC), AMBIENT_DOC, AMBIENT_STYLE);
const AMBIENT_COLORS = groupColorMap(AMBIENT_GRAPH.groups);

const SIDEBAR_SIZE: PanelSizeOptions = {
  storageKey: "ngv:sidebar-width",
  edge: "right",
  fallback: 316,
  min: 250,
  max: () => 680,
};

const DRAWER_SIZE: PanelSizeOptions = {
  storageKey: "ngv:drawer-height",
  edge: "top",
  fallback: 200,
  min: 120,
  // Whatever the window allows, less enough graph to still aim at.
  max: () => Math.max(120, window.innerHeight - 160),
};

const STATS_SIZE: PanelSizeOptions = {
  storageKey: "ngv:stats-width",
  edge: "left",
  fallback: 340,
  min: 280,
  // Narrower than the sidebar's ceiling: this one is the second panel taking
  // width off the graph, so it yields first on a small window.
  max: () => Math.max(280, Math.min(680, window.innerWidth - 480)),
};

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [edgeTableIndex, setEdgeTableIndex] = useState(0);
  const [nodeTableIndex, setNodeTableIndex] = useState<number | null>(null);
  // Every change to the document goes through the history, so an undo can
  // never quietly discard one that was recorded nowhere.
  const { doc, edit: editDoc, reset: resetDoc, undo, redo, undoLabel, redoLabel } = useDocHistory();
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
  // One selection covers both marks: a node, or an edge between two of them.
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const selectedId = selectedNode(selection);
  const [tableTab, setTableTab] = useState<EditTarget>("edges");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Overlays the user has dismissed, so the graph can be presented or
  // screenshotted clean. Nothing underneath changes: showing them again brings
  // each one back as it was.
  const [hiddenOverlays, setHiddenOverlays] = useState<ReadonlySet<Overlay>>(() => new Set());
  // Both stage overlays can be dragged between corners, so either can be moved
  // off whatever part of the graph it happens to be sitting on.
  const [toolbarCorner, setToolbarCorner] = useState<Corner>("top-left");
  const [legendCorner, setLegendCorner] = useState<Corner>("bottom-left");
  // Panels are only ever hidden with CSS, never unmounted, so a collapse does
  // not throw away a half-written script, an unsaved gist token, or the search
  // and grouping set up over the table.
  const [collapsed, setCollapsed] = useState<ReadonlySet<Panel>>(() => new Set<Panel>());
  const sidebar = usePanelSize(SIDEBAR_SIZE);
  const drawer = usePanelSize(DRAWER_SIZE);
  const stats = usePanelSize(STATS_SIZE);
  const resizing = sidebar.resizing || drawer.resizing || stats.resizing;
  const toolbarDrag = useCornerDrag(toolbarCorner, setToolbarCorner);

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

  const adoptDoc = useCallback(
    (next: GraphDoc, nextStyle: GraphStyle) => {
      resetDoc(next);
      setStyle(nextStyle);
      setChain([]);
      setShowIsolated(next.nodesDeclared);
      setSelection(null);
      setError(null);
    },
    [resetDoc],
  );

  const adoptImported = useCallback(
    (imported: ImportedGraph & { workspace?: import("./lib/io").Workspace }) => {
      const { doc: next, positions, workspace } = imported;
      setDataset(null);
      setEdgeTableIndex(0);
      setNodeTableIndex(null);
      seedPositionsRef.current = positions ?? null;
      resetDoc(next);
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
      setSelection(null);
      setError(null);
    },
    [resetDoc],
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

  const setOverlayVisible = useCallback((key: Overlay, visible: boolean) => {
    setHiddenOverlays((current) => {
      const next = new Set(current);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * One switch for the whole window: the overlays go out and the panels fold
   * away, leaving the graph alone on the screen. Nothing underneath changes,
   * so showing everything again brings it all back as it was.
   */
  const hideEverything = useCallback(() => {
    setHiddenOverlays(new Set(OVERLAYS));
    setCollapsed(new Set(PANELS));
  }, []);

  const showEverything = useCallback(() => {
    setHiddenOverlays((current) => (current.size === 0 ? current : new Set()));
    setCollapsed((current) => (current.size === 0 ? current : new Set()));
  }, []);

  /** The same switch for the panels alone, leaving the overlays where they are. */
  const hidePanels = useCallback(() => setCollapsed(new Set(PANELS)), []);

  const showPanels = useCallback(() => {
    setCollapsed((current) => (current.size === 0 ? current : new Set()));
  }, []);

  const setPanelOpen = useCallback((key: Panel, open: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const togglePanel = useCallback((key: Panel) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * A selection is answered in the statistics panel, so picking a node or an
   * edge brings that panel out from wherever it was put away.
   */
  const handleSelect = useCallback(
    (next: GraphSelection | null) => {
      setSelection(next);
      if (next !== null) setPanelOpen("stats", true);
    },
    [setPanelOpen],
  );

  /** The node-only form, for the panels that never point at an edge. */
  const handleSelectNode = useCallback(
    (id: string | null) => handleSelect(id === null ? null : nodeSelection(id)),
    [handleSelect],
  );

  const anythingHidden = hiddenOverlays.size > 0 || collapsed.size > 0;
  const panelsHidden = collapsed.size === PANELS.length;

  // Whenever a panel changes how much room the graph has, the view is fitted
  // to what is left, the way it is after a layout runs. A drag waits for the
  // pointer to come up: re-fitting on every frame of one would be a fight.
  useEffect(() => {
    if (resizing) return;
    canvasRef.current?.fit();
  }, [collapsed, resizing, sidebar.size, drawer.size, stats.size]);

  // H clears the window or puts it back and P does the same for the panels
  // alone; Escape only ever puts things back, so the way out is never hidden
  // along with everything else. Ctrl+Z and its partners walk the document
  // history, except inside a field, where they are the browser's to handle.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable]") !== null;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !inField) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
          return;
        }
        if ((key === "z" && e.shiftKey) || key === "y") {
          e.preventDefault();
          redo();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inField) return;
      if (e.key === "h" || e.key === "H") {
        if (anythingHidden) showEverything();
        else hideEverything();
      } else if (e.key === "p" || e.key === "P") {
        if (panelsHidden) showPanels();
        else hidePanels();
      } else if (e.key === "Escape") {
        showEverything();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    anythingHidden,
    panelsHidden,
    hideEverything,
    showEverything,
    hidePanels,
    showPanels,
    undo,
    redo,
  ]);

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
    resetDoc(null);
    setStyle(DEFAULT_STYLE);
    setChain([]);
    setShowIsolated(false);
    setSelection(null);
    setCollapsed(new Set<Panel>());
    setHiddenOverlays(new Set());
    setError(null);
  }, [resetDoc]);

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
      editDoc("the column mapping", (current) => reconcileNodes({ ...current, mapping }));
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
    [doc, editDoc],
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
      editDoc("computing metrics", (current) => applyComputedColumns(current, run.result));
      return run;
    },
    [base, editDoc],
  );

  const handleEditCell = useCallback(
    (target: EditTarget, rowIndex: number, column: string, value: CellValue) => {
      editDoc("the cell edit", (current) => setCell(current, target, rowIndex, column, value));
    },
    [editDoc],
  );

  const handleAddRow = useCallback(
    (target: EditTarget) => {
      editDoc("adding a row", (current) => addRow(current, target));
      if (target === "nodes") setShowIsolated(true);
    },
    [editDoc],
  );

  const handleDeleteRow = useCallback(
    (target: EditTarget, rowIndex: number) => {
      editDoc("deleting a row", (current) => deleteRows(current, target, [rowIndex]));
    },
    [editDoc],
  );

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
      editDoc(`writing "${name}"`, (current) => applyComputedColumns(current, runResult));
      // Send the user where the column actually landed.
      setTableTab(mode === "edge" ? "edges" : "nodes");
      return `Wrote "${name}" over ${Object.keys(values).length} rows in ${Math.round(elapsedMs)}ms.`;
    },
    [base, doc, editDoc],
  );

  const handleClearComputed = useCallback(() => {
    editDoc("clearing the computed columns", clearComputedColumns);
  }, [editDoc]);

  /** Open the data table on whichever tab holds the columns just written. */
  const handleShowColumns = useCallback(
    (target: EditTarget) => {
      setTableTab(target);
      setPanelOpen("table", true);
    },
    [setPanelOpen],
  );

  /**
   * Clicking a legend entry or a breakdown bar drops a one-value column step
   * onto the chain; clicking the same one again takes it back off.
   */
  const handleToggleValueFilter = useCallback(
    (table: "nodes" | "edges", column: string, value: string) => {
      setChain((current) => {
        const existing = findValueStep(current, table, column, value);
        if (existing) return current.filter((s) => s.id !== existing.id);
        return [
          ...current,
          {
            id: newStepId(),
            enabled: true,
            kind: "column",
            table,
            column,
            op: { kind: "values", selected: [value] },
          },
        ];
      });
    },
    [],
  );

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
  const showLegend = graph !== null && hasLegend(graph);

  const pickAnyFile = () => {
    document.querySelector<HTMLInputElement>("input[type=file]")?.click();
  };

  const sidebarCollapsed = collapsed.has("sidebar");
  const tableCollapsed = collapsed.has("table");
  // With no file loaded there is nothing to count, so the statistics panel
  // stays out of the layout whatever the user last chose.
  const statsCollapsed = collapsed.has("stats") || graph === null || doc === null;

  return (
    <div
      className={`app${sidebarCollapsed ? " app-sidebar-collapsed" : ""}${
        tableCollapsed ? " app-table-collapsed" : ""
      }${statsCollapsed ? " app-stats-collapsed" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebar.size}px`,
          "--drawer-height": `${drawer.size}px`,
          "--stats-width": `${stats.size}px`,
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

      <div className="resizer" aria-label="Sidebar width" {...sidebar.handleProps} />

      {/* One control in one place: it rides the sidebar's edge, so collapsing
          and expanding happen wherever that edge currently is. */}
      <button
        type="button"
        className="panel-toggle sidebar-toggle"
        onClick={() => togglePanel("sidebar")}
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
          className="panel-toggle drawer-toggle"
          onClick={() => togglePanel("table")}
          aria-expanded={!tableCollapsed}
          title={tableCollapsed ? "Show the data table" : "Hide the data table"}
          aria-label={tableCollapsed ? "Show the data table" : "Hide the data table"}
        >
          <span aria-hidden="true">{tableCollapsed ? "‹" : "›"}</span>
        </button>
      )}

      {/* And once more, mirrored, on the statistics panel's edge. */}
      {graph && doc && (
        <button
          type="button"
          className="panel-toggle stats-toggle"
          onClick={() => togglePanel("stats")}
          aria-expanded={!statsCollapsed}
          title={statsCollapsed ? "Show the statistics panel" : "Hide the statistics panel"}
          aria-label={statsCollapsed ? "Show the statistics panel" : "Hide the statistics panel"}
        >
          <span aria-hidden="true">{statsCollapsed ? "‹" : "›"}</span>
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
                selection={selection}
                onSelect={handleSelect}
                seedPositions={seedPositionsRef}
              />
              {hiddenOverlays.has("toolbar") && (
                <button
                  type="button"
                  className={`tool-btn chrome-restore at-${toolbarCorner}`}
                  onClick={showEverything}
                  title="Bring back everything that is hidden (H)"
                >
                  Show controls
                </button>
              )}
              {!hiddenOverlays.has("toolbar") && (
                <div
                  ref={toolbarDrag.ref}
                  className={`toolbar at-${toolbarCorner}${
                    toolbarDrag.dragging ? " dragging" : ""
                  }`}
                  title="Drag into another corner"
                  {...toolbarDrag.handleProps}
                >
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
                    title="Run the layout again"
                  >
                    Layout
                  </button>
                  <span className="tool-sep" aria-hidden="true" />
                  <ViewMenu
                    hidden={hiddenOverlays}
                    collapsed={collapsed}
                    legendAvailable={showLegend}
                    corner={toolbarCorner}
                    onSetOverlayVisible={setOverlayVisible}
                    onSetPanelOpen={setPanelOpen}
                    onHideAll={hideEverything}
                    onShowAll={showEverything}
                    onHidePanels={hidePanels}
                    onShowPanels={showPanels}
                  />
                  <button
                    type="button"
                    className="overlay-x"
                    onClick={() => setOverlayVisible("toolbar", false)}
                    title="Hide these buttons"
                    aria-label="Hide these buttons"
                  >
                    ×
                  </button>
                </div>
              )}
              {showLegend && !hiddenOverlays.has("legend") && (
                <Legend
                  doc={doc}
                  graph={graph}
                  style={style}
                  colors={colors}
                  edgeColors={edgeColors}
                  chain={chain}
                  corner={legendCorner}
                  stacked={legendCorner === toolbarCorner && !hiddenOverlays.has("toolbar")}
                  onCornerChange={setLegendCorner}
                  onToggleValueFilter={handleToggleValueFilter}
                  onHide={() => setOverlayVisible("legend", false)}
                />
              )}
              {graph.nodes.length === 0 && (
                <div className="no-match">
                  <p>No rows match the current filters.</p>
                </div>
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
                selection={null}
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
            selection={selection}
            onSelect={handleSelect}
            chain={chain}
            onChainChange={setChain}
            onEditCell={handleEditCell}
            onAddRow={handleAddRow}
            onDeleteRow={handleDeleteRow}
            onUndo={undo}
            onRedo={redo}
            undoLabel={undoLabel}
            redoLabel={redoLabel}
            gripProps={drawer.handleProps}
          />
        )}
      </div>

      {/* The third panel takes its own column, so the graph gets the width back
          when it is put away rather than being covered by it. */}
      {graph && doc && (
        <>
          <div
            className="resizer resizer-stats"
            aria-label="Statistics width"
            {...stats.handleProps}
          />
          <StatsPanel
            doc={doc}
            rows={filteredRows}
            totalRows={doc.edges.rows.length}
            graph={graph}
            colorColumn={graph.ranking ? null : colorColumn}
            colors={colors}
            edgeColors={edgeColors}
            chain={chain}
            selection={selection}
            onToggleValueFilter={handleToggleValueFilter}
            onSelectNode={handleSelectNode}
            onClose={() => setPanelOpen("stats", false)}
          />
        </>
      )}
    </div>
  );
}
