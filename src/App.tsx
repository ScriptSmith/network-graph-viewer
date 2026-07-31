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
import { SAMPLE_DATASET, SAMPLES, type SampleNetwork } from "./samples";
import { ACCEPTED_EXTENSIONS, parseFile, guessStyle } from "./lib/parse";
import {
  decodePayload,
  detectFormat,
  downloadText,
  exportAs,
  extractGistFileHint,
  extractGistId,
  fetchGist,
  gistLink,
  matchesFileHint,
  parseText,
  readUrlSource,
  TEXT_EXTENSIONS,
  withoutUrlSource,
  writeDataLink,
  type ExportFormat,
  type ImportedGraph,
  type Position,
  type UrlSource,
  type Workspace,
} from "./lib/io";
import {
  applyComputedColumns,
  buildDoc,
  clearComputedColumns,
  reconcileNodes,
  retargetStyle,
} from "./lib/doc";
import { deleteColumn, renameColumn } from "./lib/bulk";
import { applyStyle, buildBaseGraph, hasLegend } from "./lib/graph";
import { applyChain, findValueStep, newStepId, retargetChain, type FilterStep } from "./lib/filter";
import { defaultParams, type LayoutId, type LayoutParams, type ParamValue } from "./lib/layouts";
import { addRow, deleteRows, setCell, type EditTarget } from "./lib/edit";
import { toMetricGraph, type MetricOptions } from "./lib/metrics";
import { computeMetrics, runScriptInWorker } from "./lib/metrics/runner";
import { interpretResult, normalizeEdgeKeys, toScriptGraph } from "./lib/script/payload";
import type { ScriptRunRequest } from "./components/ScriptPanel";
import { activeWithin, listen, useRootNode } from "./RootContext";
import { GRAPH_THEMES, type ThemeMode } from "./theme";
import { detectHostTheme, watchHostTheme, type ThemePreference } from "./lib/hostTheme";
import { downloadPng, downloadSvg } from "./lib/export";
import { groupColorMap, resolvePalette } from "./theme";
import { usePanelSize, type PanelSizeOptions } from "./usePanelSize";
import { useCornerDrag } from "./useCornerDrag";
import { useDocHistory } from "./useDocHistory";
import { GraphCanvas, type GraphCanvasHandle } from "./components/GraphCanvas";
import { Sidebar } from "./components/Sidebar";
import { SampleList } from "./components/SampleList";
import { StatsPanel } from "./components/StatsPanel";
import { TableDrawer } from "./components/TableDrawer";
import { Legend } from "./components/Legend";
import { ViewMenu } from "./components/ViewMenu";
import iconUrl from "../docs/icon.svg";

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

/** Names a URL source, so a link the app wrote is not read straight back in. */
function sourceKey(source: UrlSource): string {
  return source.kind === "gist" ? `gist:${source.reference}` : `data:${source.payload}`;
}

/**
 * What a host hands the app when it is mounted inside something else rather
 * than served as a page. Its presence is also what keeps the app off the
 * address bar: an embedded graph has nothing to do with the URL of the page
 * around it, so links are neither read from it nor written back to it.
 */
export interface EmbedProps {
  /** The workspace to open with, in place of the empty state. */
  initial?: Workspace;
  /**
   * Where this app is served from. Share links are built against it, so a
   * link copied out of a notebook points at the app rather than at the
   * notebook it happened to be running in.
   */
  appUrl?: string;
  /**
   * Which panels start open. Embedded the default is none of them: a notebook
   * cell is not a window, and the graph is what the cell is for. The stage's
   * own edge tabs put any of them back.
   */
  panels?: Panel[];
  /** "auto" follows the host's own colour scheme and keeps following it. */
  theme?: ThemePreference;
  /** Called when the selected node changes, including when it clears. */
  onSelect?: (node: string | null) => void;
  /** Called after the tables are edited, so a host can read the changes back. */
  onDocChange?: (doc: GraphDoc) => void;
}

export default function App({ embed }: { embed?: EmbedProps } = {}) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  // The gist the graph on screen came from, so a save offers to update it.
  const [gistId, setGistId] = useState<string | null>(null);
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
  // Something worth saying that is not a failure: so far, that a file held
  // more rows than were read.
  const [notice, setNotice] = useState<string | null>(null);
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<Panel>>(() => {
    if (!embed) return new Set<Panel>();
    const open = new Set(embed.panels ?? []);
    return new Set(PANELS.filter((p) => !open.has(p)));
  });
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
  // Everything that draws in colour reads these two: the palette in force, and
  // the group-to-slot map it produced for the graph on screen.
  const palette = useMemo(() => resolvePalette(style), [style]);
  const colors = useMemo(
    () => (graph ? groupColorMap(graph.groups, palette.categorical) : new Map<string, string>()),
    [graph, palette],
  );
  const edgeColors = useMemo(
    () =>
      graph ? groupColorMap(graph.edgeGroups, palette.categorical) : new Map<string, string>(),
    [graph, palette],
  );

  // What the address bar last pointed at, so a link this app wrote is not
  // mistaken for one the user just pasted in.
  const urlSourceRef = useRef<string | null>(null);

  /** Point the address bar somewhere without reloading, and remember where. */
  // Served as a page this is the document; embedded it is the shadow root the
  // host handed over, so keys pressed in a notebook cell are not ours.
  const root = useRootNode();
  const embedded = embed !== undefined;

  /**
   * Colour scheme. A page defaults to the dark it has always been; embedded it
   * defaults to following whatever the notebook is doing, since a dark widget
   * sitting in a light notebook looks like a bug rather than a choice.
   */
  const [themePref, setThemePref] = useState<ThemePreference>(
    () => embed?.theme ?? (embed ? "auto" : "dark"),
  );
  const [hostTheme, setHostTheme] = useState<ThemeMode>(() => detectHostTheme());
  const themeRoot = root instanceof Document ? root.documentElement : (root.host as HTMLElement);

  // Only worth watching while we are actually following it.
  useEffect(() => {
    if (themePref !== "auto") return;
    const reread = () => setHostTheme(detectHostTheme(themeRoot));
    reread();
    return watchHostTheme(reread);
  }, [themePref, themeRoot]);

  const themeMode: ThemeMode = themePref === "auto" ? hostTheme : themePref;
  const graphTheme = GRAPH_THEMES[themeMode];

  // The tokens hang off the root rather than off the app's own div, because
  // they have to reach the popovers portalled out of it.
  useEffect(() => {
    themeRoot.setAttribute("data-theme", themeMode);
    return () => themeRoot.removeAttribute("data-theme");
  }, [themeRoot, themeMode]);
  const rewriteUrl = useCallback(
    (href: string) => {
      const source = readUrlSource(href);
      urlSourceRef.current = source === null ? null : sourceKey(source);
      // Embedded, the address bar belongs to the page around us.
      if (!embedded) window.history.replaceState(null, "", href);
    },
    [embedded],
  );

  /**
   * Data has arrived from somewhere other than the link in the address bar, so
   * take the link out rather than leave one that would reload into something
   * else entirely.
   */
  const forgetUrlSource = useCallback(() => {
    setGistId(null);
    if (urlSourceRef.current !== null) rewriteUrl(withoutUrlSource());
  }, [rewriteUrl]);

  const adoptDoc = useCallback(
    (next: GraphDoc, nextStyle: GraphStyle) => {
      resetDoc(next);
      setStyle(nextStyle);
      setChain([]);
      setShowIsolated(next.nodesDeclared);
      setSelection(null);
      setError(null);
      setNotice(null);
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
      setNotice(null);
    },
    [resetDoc],
  );

  const adoptDataset = useCallback(
    (next: Dataset, options: { nodeTable?: number; style?: Partial<GraphStyle> } = {}) => {
      const edges = next.tables[0];
      const nodeIndex = options.nodeTable ?? null;
      const nodes = nodeIndex === null ? undefined : next.tables[nodeIndex];
      const nextDoc = buildDoc(next.fileName, edges, { nodes });
      setDataset(next);
      setEdgeTableIndex(0);
      setNodeTableIndex(nodeIndex);
      adoptDoc(nextDoc, { ...guessStyle(edges, nextDoc.mapping), ...options.style });
      setNotice(
        next.truncated
          ? `Read the first ${next.truncated.read.toLocaleString()} of ${next.truncated.total.toLocaleString()} rows.`
          : null,
      );
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
          // Only once the file has actually read: a link is worth keeping
          // until something has arrived to replace what it points at.
          forgetUrlSource();
          if (imported.dataset) adoptDataset(imported.dataset);
          else adoptImported(imported);
          return;
        }
        const parsed = await parseFile(file);
        forgetUrlSource();
        adoptDataset(parsed);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that file.");
      }
    },
    [adoptDataset, adoptImported, forgetUrlSource],
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
            forgetUrlSource();
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
    return listen(root, "paste", onPaste);
  }, [adoptDataset, adoptImported, handleFile, forgetUrlSource, root]);

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
    return listen(root, "keydown", onKeyDown);
  }, [
    root,
    anythingHidden,
    panelsHidden,
    hideEverything,
    showEverything,
    hidePanels,
    showPanels,
    undo,
    redo,
  ]);

  const handleSample = useCallback(
    (network: SampleNetwork) => {
      forgetUrlSource();
      adoptDataset(network.dataset, { nodeTable: network.nodeTable, style: network.style });
    },
    [adoptDataset, forgetUrlSource],
  );

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
        // Whatever was pasted, the address bar ends up holding the plain id, so
        // the page's own URL is the link worth sharing.
        setGistId(id);
        rewriteUrl(gistLink(id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load that gist.");
      }
    },
    [adoptDataset, adoptImported, rewriteUrl],
  );

  /**
   * Open whatever a link names: a graph packed into the fragment, or a gist to
   * go and fetch. Nothing else is followed, so a crafted link cannot point the
   * browser at an arbitrary host.
   */
  const handleUrlSource = useCallback(
    async (source: UrlSource) => {
      urlSourceRef.current = sourceKey(source);
      if (source.kind === "gist") {
        await handleGist(source.reference);
        return;
      }
      setGistId(null);
      try {
        const text = await decodePayload(source.payload);
        const imported = await parseText(text, "Shared graph");
        if (imported.dataset) adoptDataset(imported.dataset);
        else adoptImported(imported);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read the graph in that link.");
      }
    },
    [adoptDataset, adoptImported, handleGist],
  );

  // A link with a graph in it opens straight into that graph. Embedded, the
  // graph comes from the host instead, and the surrounding page's own URL is
  // none of our business.
  const urlConsumed = useRef(false);
  useEffect(() => {
    if (urlConsumed.current) return;
    urlConsumed.current = true;
    if (embed) {
      const initial = embed.initial;
      if (initial) {
        const positions = new Map(Object.entries(initial.positions ?? {}));
        adoptImported({
          doc: initial.doc,
          positions: positions.size > 0 ? positions : undefined,
          workspace: initial,
        });
      }
      return;
    }
    const source = readUrlSource();
    if (source) void handleUrlSource(source);
  }, [handleUrlSource, embed, adoptImported]);

  // Pasting a link into the address bar of a tab that is already open changes
  // only the fragment, which never reloads the page; without this it would do
  // nothing at all.
  useEffect(() => {
    if (embedded) return;
    const onHashChange = () => {
      const source = readUrlSource();
      if (source === null || sourceKey(source) === urlSourceRef.current) return;
      void handleUrlSource(source);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [handleUrlSource, embedded]);

  /**
   * Report back to an embedding host. The selection goes out the moment it
   * changes, which costs nothing; the document waits for a pause first,
   * because it carries every row and a host on the far end of a message
   * channel should not be sent one of those per keystroke.
   */
  const onSelect = embed?.onSelect;
  useEffect(() => {
    onSelect?.(selectedId);
  }, [selectedId, onSelect]);

  const onDocChange = embed?.onDocChange;
  useEffect(() => {
    if (!onDocChange || !doc) return;
    const timer = setTimeout(() => onDocChange(doc), 250);
    return () => clearTimeout(timer);
  }, [doc, onDocChange]);

  const handleClear = useCallback(() => {
    forgetUrlSource();
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
  }, [resetDoc, forgetUrlSource]);

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
          nodeImage: fix(s.nodeImage, "none"),
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
   * Renaming or deleting a column reaches past the document. Style options and
   * filter steps name their column by string, so both have to be pointed at the
   * new name, or off the old one, in the same act that changes it: a rename that
   * left them behind would silently un-style the graph and drop a filter's
   * meaning without dropping the filter.
   */
  const editColumn = useCallback(
    (
      label: string,
      target: EditTarget,
      column: string,
      to: string | null,
      update: (doc: GraphDoc) => GraphDoc,
    ) => {
      if (!doc) return;
      const next = update(doc);
      // A refused edit changes nothing, and nothing outside it should move.
      if (next === doc) return;
      editDoc(label, () => next);
      setStyle((s) => retargetStyle(s, next, column, to));
      setChain((c) => retargetChain(c, target, column, to));
    },
    [doc, editDoc],
  );

  const handleRenameColumn = useCallback(
    (target: EditTarget, from: string, to: string) => {
      editColumn(`renaming "${from}" to "${to}"`, target, from, to, (current) =>
        renameColumn(current, target, from, to),
      );
    },
    [editColumn],
  );

  const handleDeleteColumn = useCallback(
    (target: EditTarget, column: string) => {
      editColumn(`deleting the "${column}" column`, target, column, null, (current) =>
        deleteColumn(current, target, column),
      );
    },
    [editColumn],
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
      palette,
      colors,
      chain,
      layout,
      layoutParams,
      showIsolated,
      preventOverlap,
    };
  }, [
    doc,
    graph,
    style,
    palette,
    colors,
    chain,
    layout,
    layoutParams,
    showIsolated,
    preventOverlap,
  ]);

  /** The current session as a link, built on demand because packing costs. */
  const buildLink = useCallback(async () => {
    const input = exportInput();
    if (!input) return null;
    return writeDataLink(input, embed?.appUrl);
  }, [exportInput, embed?.appUrl]);

  /** A gist just written is now where this graph lives; say so in the address bar. */
  const handleGistSaved = useCallback(
    (id: string) => {
      setGistId(id);
      rewriteUrl(gistLink(id));
    },
    [rewriteUrl],
  );

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

  // The sidebar owns the one file input; the empty state's dropzone borrows it.
  // Scoped to our own tree, or embedded it would find the host page's inputs.
  const appRef = useRef<HTMLDivElement>(null);
  const pickAnyFile = () => {
    appRef.current?.querySelector<HTMLInputElement>("input[type=file]")?.click();
  };

  const sidebarCollapsed = collapsed.has("sidebar");
  const tableCollapsed = collapsed.has("table");
  // With no file loaded there is nothing to count, so the statistics panel
  // stays out of the layout whatever the user last chose.
  const statsCollapsed = collapsed.has("stats") || graph === null || doc === null;

  return (
    <div
      ref={appRef}
      // Focusable so the keyboard shortcuts have somewhere to arrive.
      // Embedded, a click on the graph is the only thing that tells the host
      // the keys are ours now.
      tabIndex={-1}
      onPointerDown={() => {
        if (appRef.current && !appRef.current.contains(activeWithin(root))) appRef.current.focus();
      }}
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
        onGistSaved={handleGistSaved}
        gistId={gistId}
        buildLink={buildLink}
        appUrl={embed?.appUrl}
        embedded={embedded}
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
        <span className="panel-toggle-arrow" aria-hidden="true">
          {sidebarCollapsed ? "›" : "‹"}
        </span>
        {sidebarCollapsed && <span className="panel-toggle-label">Data</span>}
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
          <span className="panel-toggle-arrow" aria-hidden="true">
            {tableCollapsed ? "‹" : "›"}
          </span>
          {tableCollapsed && <span className="panel-toggle-label">Table</span>}
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
          <span className="panel-toggle-arrow" aria-hidden="true">
            {statsCollapsed ? "‹" : "›"}
          </span>
          {statsCollapsed && <span className="panel-toggle-label">Stats</span>}
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
                palette={palette}
                colors={colors}
                theme={graphTheme}
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
                    theme={themePref}
                    onThemeChange={setThemePref}
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
                  palette={palette}
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
                theme={graphTheme}
                edgeColors={new Map()}
                attrColumns={[]}
                selection={null}
                onSelect={() => {}}
                ambient
              />
              <div className="empty">
                <div className="empty-card">
                  <img className="empty-icon" src={iconUrl} alt="" width={96} height={96} />
                  <h2 className="empty-title">Two columns make a graph</h2>
                  <p className="empty-tag">
                    Upload an edge list, one row per connection: the first two columns you map
                    become the arrows, everything else becomes detail you can style, filter, and
                    chart.
                  </p>
                  <table className="example-table">
                    <thead>
                      <tr className="example-arrow" aria-hidden="true">
                        <td>
                          <span className="arrow-tail" />
                        </td>
                        <td>
                          <span className="arrow-head" />
                        </td>
                        <td colSpan={2} />
                      </tr>
                      <tr>
                        <th>Supervisor</th>
                        <th>Supervisee</th>
                        <th>Department</th>
                        <th>Meetings</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Alex Rivera</td>
                        <td>Priya Sharma</td>
                        <td>Engineering</td>
                        <td>4</td>
                      </tr>
                      <tr>
                        <td>Priya Sharma</td>
                        <td>Grace Okafor</td>
                        <td>Engineering</td>
                        <td>4</td>
                      </tr>
                      <tr>
                        <td>Alex Rivera</td>
                        <td>Kenji Mori</td>
                        <td>Operations</td>
                        <td>2</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="example-caption">
                    Any column names work; you pick which is which after loading.
                  </p>
                  <button type="button" className="dropzone" onClick={pickAnyFile}>
                    <strong>Drop a file here or click to browse</strong>
                    <span className="hint">.csv · .xlsx · .parquet · .gexf · .graphml</span>
                  </button>
                  <p className="example-caption">
                    Or copy cells in Excel or Google Sheets and paste them here (Ctrl+V or ⌘V).
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleSample(SAMPLES[0])}
                  >
                    Try the sample supervision network
                  </button>
                  <p className="example-caption">Or one of these:</p>
                  <SampleList onPick={handleSample} />
                </div>
              </div>
            </>
          )}
          {(error || notice) && (
            <div className="toast-stack">
              {error && (
                <div className="toast error" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                    ×
                  </button>
                </div>
              )}
              {notice && (
                <div className="toast" role="status">
                  <span>{notice}</span>
                  <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">
                    ×
                  </button>
                </div>
              )}
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
            onBulkEdit={editDoc}
            onRenameColumn={handleRenameColumn}
            onDeleteColumn={handleDeleteColumn}
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
            palette={palette}
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
