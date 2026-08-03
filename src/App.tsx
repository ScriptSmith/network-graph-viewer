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
  Column,
  Dataset,
  GraphDoc,
  GraphLink,
  GraphNode,
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
  exportHtml,
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
  edgeDetailColumnsFor,
  hasColumn,
  nodeDetailColumnsFor,
  reconcileNodes,
  retargetStyle,
} from "./lib/doc";
import { mergeWithOverlay, overlayFromJson, overlayIsEmpty, type MergeReport } from "./lib/overlay";
import { deleteColumn, renameColumn } from "./lib/bulk";
import { applyStyle, buildBaseGraph, hasLegend } from "./lib/graph";
import { isRemoteSource } from "./lib/images";
import { applyChain, findValueStep, newStepId, retargetChain, type FilterStep } from "./lib/filter";
import {
  defaultParams,
  projectGeo,
  type LayoutId,
  type LayoutParams,
  type ParamValue,
} from "./lib/layouts";
import { addRow, deleteRows, setCell, type EditTarget } from "./lib/edit";
import {
  hopsColumn,
  shortestRoutes,
  toMetricGraph,
  type ComputedRecipe,
  type MetricOptions,
} from "./lib/metrics";
import { edgeKey } from "./lib/cells";
import { projectBipartite, type ProjectionSide } from "./lib/project";
import { timeColumns, type TimeColumnOption } from "./lib/timeline";
import { asTime } from "./lib/parse";
import { endpointId } from "./lib/graph";
import { computeMetrics, runScriptInWorker } from "./lib/metrics/runner";
import { interpretResult, normalizeEdgeKeys, toScriptGraph } from "./lib/script/payload";
import type { ScriptRunRequest } from "./components/ScriptPanel";
import { activeWithin, listen, useRootNode } from "./RootContext";
import { GRAPH_THEMES, type ThemeMode } from "./theme";
import {
  detectHostTheme,
  isThemePreference,
  watchHostTheme,
  type ThemePreference,
} from "./lib/hostTheme";
import { downloadPng, downloadSvg } from "./lib/export";
import { groupColorMap, resolvePalette } from "./theme";
import { usePanelSize, type PanelSizeOptions } from "./usePanelSize";
import { isMotionPreference, useReducedMotion, type MotionPreference } from "./useReducedMotion";
import { usePreference } from "./usePreference";
import { useCornerDrag } from "./useCornerDrag";
import { isNarrow } from "./narrow";
import { useDocHistory } from "./useDocHistory";
import {
  GraphCanvas,
  type GraphCanvasHandle,
  type MarkSet,
  type PathHighlight,
} from "./components/GraphCanvas";
import { Timeline, type TimeWindow } from "./components/Timeline";
import { NodeSearch } from "./components/NodeSearch";
import { Sidebar } from "./components/Sidebar";
import { SampleList } from "./components/SampleList";
import { GistLoad } from "./components/GistLoad";
import { StatsPanel } from "./components/StatsPanel";
import { TableDrawer } from "./components/TableDrawer";
import { Legend } from "./components/Legend";
import { ViewMenu } from "./components/ViewMenu";
import iconUrl from "../docs/icon.svg";

const AMBIENT_TABLE = SAMPLE_DATASET.tables[0];
const AMBIENT_DOC = buildDoc(SAMPLE_DATASET.fileName, AMBIENT_TABLE);
const AMBIENT_STYLE: GraphStyle = guessStyle(AMBIENT_TABLE, AMBIENT_DOC.mapping);
const AMBIENT_BASE = buildBaseGraph(AMBIENT_DOC);
const AMBIENT_GRAPH = applyStyle(AMBIENT_BASE, AMBIENT_DOC, AMBIENT_STYLE);
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
 * What is put away before anything has been asked for. Wide, the panels sit
 * around the graph and cover nothing, so all three are out. Narrow each one is
 * the whole window, and a window opening under one of them shows the reader a
 * panel instead of the thing the panel is about: the graph, or, with nothing
 * loaded yet, the onboarding. They are asked for at that width.
 */
function defaultCollapsed(): Set<Panel> {
  return isNarrow() ? new Set(PANELS) : new Set<Panel>();
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
  /** Why there is no `initial`, when the host sent one that would not read. */
  initialError?: string;
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
  // never quietly discard one that was recorded nowhere. The edits overlay
  // rides with it: the user's table work, kept apart from the tables, for
  // saving and for laying back over updated data.
  const {
    doc,
    overlay,
    edit: editDoc,
    reset: resetDoc,
    undo,
    redo,
    undoLabel,
    redoLabel,
  } = useDocHistory();
  // The latest document, for async flows that must notice the tables moving
  // under them between their awaits and their commit.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  });
  const [style, setStyle] = useState<GraphStyle>(DEFAULT_STYLE);
  const [chain, setChain] = useState<FilterStep[]>([]);
  // The compute runs made so far, as instructions rather than values, so
  // "update data" can run the same metrics against whatever arrives next.
  const [computedRuns, setComputedRuns] = useState<ComputedRecipe[]>([]);
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
  // Nodes held where they were put, whatever the layout does around them.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const selectedId = selectedNode(selection);
  // Path tracing: armed with an origin, resolved by the next node picked.
  // The result is kept as a fact beside the paint, so the info panel can say
  // what the route is and the reader can walk it.
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [pathDirected, setPathDirected] = useState(false);
  const [pathHighlight, setPathHighlight] = useState<PathHighlight | null>(null);
  const [pathResult, setPathResult] = useState<{
    from: string;
    to: string;
    /** The equally short routes, capped; empty when there is no path. */
    routes: string[][];
    /** How many exist in all, which can exceed what was enumerated. */
    count: number;
    /** Which route is lit. */
    routeIndex: number;
    /** Hops of the lit route that run along the arrows. */
    forward: number;
  } | null>(null);
  // Spoken updates for the tools that answer without moving focus.
  const [liveMessage, setLiveMessage] = useState("");
  // The Style step's "apply to" scopes. Held here rather than in the section
  // so the schema view's pencil can point the editor at a kind from outside.
  const [nodeStyleScope, setNodeStyleScope] = useState<string | null>(null);
  const [edgeStyleScope, setEdgeStyleScope] = useState<string | null>(null);
  const [tableTab, setTableTab] = useState<EditTarget>("edges");
  // Seeded, not set in an effect: a host whose workspace would not read has
  // nothing to draw, so the reason is the first thing the cell should say.
  const [error, setError] = useState<string | null>(embed?.initialError ?? null);
  // Something worth saying that is not a failure: so far, that a file held
  // more rows than were read.
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /**
   * Whether node images may be fetched from the web. A graph can arrive from a
   * link, a gist or a file somebody else wrote, and an image column in one is a
   * list of addresses this machine would then go and ask for. That tells
   * whoever chose them that the graph was opened, and from where, which is the
   * one thing the rest of the app is careful never to say. So it waits to be
   * asked, and the answer resets whenever different data arrives.
   */
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  // Overlays the user has dismissed, so the graph can be presented or
  // screenshotted clean. Nothing underneath changes: showing them again brings
  // each one back as it was.
  const [hiddenOverlays, setHiddenOverlays] = useState<ReadonlySet<Overlay>>(() => new Set());
  // Both stage overlays can be dragged between corners, so either can be moved
  // off whatever part of the graph it happens to be sitting on.
  const [toolbarCorner, setToolbarCorner] = useState<Corner>("top-left");
  const [legendCorner, setLegendCorner] = useState<Corner>("bottom-left");
  const [timelineCorner, setTimelineCorner] = useState<Corner>("bottom-right");
  // Panels are only ever hidden with CSS, never unmounted, so a collapse does
  // not throw away a half-written script, an unsaved gist token, or the search
  // and grouping set up over the table.
  const [collapsed, setCollapsed] = useState<ReadonlySet<Panel>>(() => {
    if (!embed) return defaultCollapsed();
    const open = new Set(embed.panels ?? []);
    return new Set(PANELS.filter((p) => !open.has(p)));
  });
  const sidebar = usePanelSize(SIDEBAR_SIZE);
  const drawer = usePanelSize(DRAWER_SIZE);
  const stats = usePanelSize(STATS_SIZE);
  const resizing = sidebar.resizing || drawer.resizing || stats.resizing;
  const toolbarDrag = useCornerDrag(toolbarCorner, setToolbarCorner);

  const canvasRef = useRef<GraphCanvasHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Positions handed to the canvas on its next rebuild: a node just dropped,
  // or a whole layout that arrived with an imported file.
  const seedPositionsRef = useRef<Map<string, Position> | null>(null);

  // The timeline's window state lives up here because the chain the canvas
  // sees depends on it. A dim can only veil marks that exist, so while a
  // brush or playback is in flight the bound step's committed bounds are
  // lifted: the whole axis is on stage, and the in-flight window reaches the
  // canvas as dimming only. Committing writes the step and puts the bounds
  // back, which is when the structure actually changes.
  const lastTimewindow = useMemo(() => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i];
      if (step.kind === "timewindow" && step.enabled) return step;
    }
    return null;
  }, [chain]);
  const [timeDraft, setTimeDraftState] = useState<TimeWindow | null>(null);
  const timeDraftRef = useRef<TimeWindow | null>(null);
  // Only whether a preview is in flight, not the window itself: each tick of
  // one moves the window, and the lifted chain must not rebuild per tick.
  const previewingTime = timeDraft !== null;
  const effectiveChain = useMemo(() => {
    if (!previewingTime || lastTimewindow === null) return chain;
    // No committed bounds means nothing to lift, and the chain must pass
    // through untouched: a cloned step is a new identity, and identity is
    // what rebuilds the scene.
    if (lastTimewindow.min === null && lastTimewindow.max === null) return chain;
    return chain.map((s) => (s.id === lastTimewindow.id ? { ...s, min: null, max: null } : s));
  }, [chain, previewingTime, lastTimewindow]);

  const chained = useMemo(
    () => (doc ? applyChain(doc, effectiveChain, { showIsolated }) : null),
    [doc, effectiveChain, showIsolated],
  );
  const base = chained?.graph ?? null;
  const filteredRows = base?.rows ?? [];
  const graph = useMemo(
    () => (base && doc ? applyStyle(base, doc, style) : null),
    [base, doc, style],
  );
  // Everything that draws in colour reads these two: the palette in force, and
  // the group-to-slot map it produced for the graph on screen. Type overrides
  // land on the map here, once, so the legend, the bars and the details panel
  // all answer with the same swatch the marks are wearing.
  const palette = useMemo(() => resolvePalette(style), [style]);
  const colors = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = groupColorMap(graph.groups, palette.categorical);
    const typeStyles = style.typeStyles;
    if (typeStyles && styleColumn(style.nodeColor) === typeStyles.column) {
      for (const [value, override] of Object.entries(typeStyles.styles)) {
        if (override.color !== undefined && map.has(value)) map.set(value, override.color);
      }
    }
    return map;
  }, [graph, palette, style.typeStyles, style.nodeColor]);
  const edgeColors = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = groupColorMap(graph.edgeGroups, palette.categorical);
    const types = style.edgeTypeStyles;
    if (types && styleColumn(style.edgeColor) === types.column) {
      for (const [value, override] of Object.entries(types.styles)) {
        if (override.color !== undefined && map.has(value)) map.set(value, override.color);
      }
    }
    return map;
  }, [graph, palette, style.edgeTypeStyles, style.edgeColor]);

  // What the address bar last pointed at, so a link this app wrote is not
  // mistaken for one the user just pasted in.
  const urlSourceRef = useRef<string | null>(null);

  /** Point the address bar somewhere without reloading, and remember where. */
  // Served as a page this is the document; embedded it is the shadow root the
  // host handed over, so keys pressed in a notebook cell are not ours.
  const root = useRootNode();
  const embedded = embed !== undefined;

  /**
   * Colour scheme. A page defaults to the dark it has always been and then
   * remembers whatever was chosen instead; embedded it defaults to following
   * whatever the notebook is doing, since a dark widget sitting in a light
   * notebook looks like a bug rather than a choice, and a host that named a
   * theme has said what it wants.
   */
  const [themePref, setThemePref] = usePreference<ThemePreference>({
    key: "ngv:theme",
    fallback: embed?.theme ?? (embed ? "auto" : "dark"),
    isValid: isThemePreference,
    remember: !embedded,
  });
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

  /**
   * Motion, resolved the way the colour scheme is: the system preference is
   * the default and the View menu can override it either way. The one answer
   * goes to the canvas as a prop and onto the root as `data-motion`, where the
   * stylesheet's transitions read it, so the two halves cannot disagree. An
   * override is remembered alongside the colours: someone who asked for
   * stillness once should not have to ask again on the next visit.
   */
  const [motionPref, setMotionPref] = usePreference<MotionPreference>({
    key: "ngv:motion",
    fallback: "auto",
    isValid: isMotionPreference,
    remember: !embedded,
  });
  const systemReducedMotion = useReducedMotion();
  const reducedMotion = motionPref === "auto" ? systemReducedMotion : motionPref === "reduced";

  useEffect(() => {
    themeRoot.setAttribute("data-motion", reducedMotion ? "reduced" : "full");
    return () => themeRoot.removeAttribute("data-motion");
  }, [themeRoot, reducedMotion]);
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

  /**
   * Narrow, a graph that has just arrived is standing behind whichever sheet
   * was used to fetch it, so all three step aside and let it through. Wide they
   * are around the graph rather than over it, cover nothing, and stay as the
   * reader left them. Only a new graph does this, never a rebuild of the one
   * already open: that is the reader working in the sidebar, and the sidebar
   * closing under them is not an answer to anything they asked.
   */
  const revealGraph = useCallback(() => {
    if (isNarrow()) setCollapsed(new Set(PANELS));
  }, []);

  const adoptDoc = useCallback(
    (next: GraphDoc, nextStyle: GraphStyle) => {
      resetDoc(next);
      setStyle(nextStyle);
      setChain([]);
      setComputedRuns([]);
      setShowIsolated(next.nodesDeclared);
      setSelection(null);
      setPinned(new Set());
      setError(null);
      setNotice(null);
      setAllowRemoteImages(false);
    },
    [resetDoc],
  );

  const adoptImported = useCallback(
    (imported: ImportedGraph & { workspace?: import("./lib/io").Workspace }) => {
      const { doc: next, positions, style: stated, workspace } = imported;
      setDataset(null);
      setEdgeTableIndex(0);
      setNodeTableIndex(null);
      seedPositionsRef.current = positions ?? null;
      resetDoc(next, workspace?.edits ? overlayFromJson(workspace.edits) : undefined);
      setStyle(
        workspace?.style ?? { ...guessStyle(next.edges, next.mapping, next.nodes), ...stated },
      );
      setChain(workspace?.chain ?? []);
      setComputedRuns(workspace?.computed ?? []);
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
      setPinned(new Set(workspace?.pinned ?? []));
      setError(null);
      setNotice(null);
      setAllowRemoteImages(false);
      revealGraph();
    },
    [resetDoc, revealGraph],
  );

  const adoptDataset = useCallback(
    (
      next: Dataset,
      options: { nodeTable?: number; style?: Partial<GraphStyle>; nodeAttrs?: string[] } = {},
    ) => {
      const edges = next.tables[0];
      const nodeIndex = options.nodeTable ?? null;
      const nodes = nodeIndex === null ? undefined : next.tables[nodeIndex];
      const nextDoc = buildDoc(next.fileName, edges, { nodes, nodeAttrs: options.nodeAttrs });
      setDataset(next);
      setEdgeTableIndex(0);
      setNodeTableIndex(nodeIndex);
      adoptDoc(nextDoc, { ...guessStyle(edges, nextDoc.mapping, nextDoc.nodes), ...options.style });
      setNotice(
        next.truncated
          ? `Read the first ${next.truncated.read.toLocaleString()} of ${next.truncated.total.toLocaleString()} rows.`
          : null,
      );
      revealGraph();
    },
    [adoptDoc, revealGraph],
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

  /**
   * "Update data": fresh rows under the same setup. The incoming file
   * becomes the new tables while the chain, the style, the layout, the
   * scripts and the panels all stay put; the edits overlay lays the user's
   * table work back on top, and the compute recipe re-runs against what
   * arrived. Anything that no longer applies is counted and said, and the
   * whole update is one undo step.
   */
  const handleUpdateFile = useCallback(
    async (file: File) => {
      if (!doc) return;
      try {
        // Parse the way a fresh load would, but keep everything around it.
        let incomingDataset: Dataset | null = null;
        let incoming: GraphDoc;
        const lowered = file.name.toLowerCase();
        if (TEXT_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
          const imported = await parseText(await file.text(), file.name);
          incomingDataset = imported.dataset ?? null;
          incoming = imported.doc;
        } else {
          incomingDataset = await parseFile(file);
          incoming = doc;
        }
        let nextEdgeIndex = 0;
        let nextNodeIndex: number | null = null;
        let lostNodeSheet: string | null = null;
        let guessedEdgeSheet: string | null = null;
        let keptMapping = false;
        if (incomingDataset !== null) {
          const tables = incomingDataset.tables;
          // Both sheets are found again by name, not by position: sheet order
          // is the first thing a re-export shuffles, and a wrong sheet
          // standing in for either table would merge nonsense silently. An
          // edge sheet that lost its name falls back to the first sheet that
          // is not the node sheet, so a rename alone cannot strand the update.
          const namedNode =
            nodeTableIndex !== null ? tables.findIndex((t) => t.name === doc.nodes.name) : -1;
          const namedEdge = tables.findIndex((t) => t.name === doc.edges.name);
          nextEdgeIndex =
            namedEdge !== -1
              ? namedEdge
              : Math.max(
                  0,
                  tables.findIndex((_, i) => i !== namedNode),
                );
          const edges = tables[nextEdgeIndex];
          if (namedEdge === -1 && tables.length > 1) guessedEdgeSheet = edges.name;
          let nodes;
          if (nodeTableIndex !== null) {
            if (namedNode !== -1 && namedNode !== nextEdgeIndex) {
              nodes = tables[namedNode];
              nextNodeIndex = namedNode;
            } else {
              lostNodeSheet = doc.nodes.name;
            }
          }
          // The recipe keeps the mapping wherever the new file still answers
          // to it; otherwise the columns are guessed the way a fresh load
          // guesses them.
          const mapping =
            hasColumn(edges, doc.mapping.source) && hasColumn(edges, doc.mapping.target)
              ? {
                  ...doc.mapping,
                  attrs: doc.mapping.attrs.filter((a) => hasColumn(edges, a)),
                }
              : undefined;
          keptMapping = mapping !== undefined;
          incoming = buildDoc(file.name, edges, { nodes, mapping });
        }

        // The user's table work rides on top of whatever arrived.
        let report: MergeReport | null = null;
        let merged = incoming;
        if (!overlayIsEmpty(overlay)) {
          const result = mergeWithOverlay(doc, overlay, incoming);
          merged = result.doc;
          report = result.report;
        }

        // The compute recipe re-runs against the new data, over the whole
        // graph: the chain may name the very columns being recomputed.
        let final = merged;
        for (const run of computedRuns) {
          const graphNow = buildBaseGraph(final, { showIsolated: true });
          const computed = await computeMetrics(
            toMetricGraph(graphNow, run.options.weightColumn),
            run.metrics,
            run.options,
          );
          final = applyComputedColumns(final, computed.result);
        }

        // The hover pickers are refiltered only now, against the merged
        // tables, because the overlay may have just restored user-added
        // columns the early guess against the raw file could not see.
        if (incomingDataset !== null && keptMapping) {
          final = {
            ...final,
            mapping: {
              ...final.mapping,
              attrs: doc.mapping.attrs.filter((a) => hasColumn(final.edges, a)),
              ...(doc.mapping.nodeAttrs !== undefined
                ? { nodeAttrs: doc.mapping.nodeAttrs.filter((a) => hasColumn(final.nodes, a)) }
                : {}),
            },
          };
        }

        // Steps and tokens naming columns the new data lacks degrade exactly
        // like a deleted column does, and the shortfall is counted.
        const missingEdgeCols = doc.edges.columns
          .map((c) => c.name)
          .filter((name) => !hasColumn(final.edges, name));
        const missingNodeCols = doc.nodes.columns
          .map((c) => c.name)
          .filter((name) => !hasColumn(final.nodes, name));
        let nextStyle = style;
        for (const name of [...new Set([...missingEdgeCols, ...missingNodeCols])]) {
          nextStyle = retargetStyle(nextStyle, final, name, null);
        }
        let nextChain = chain;
        for (const name of missingEdgeCols)
          nextChain = retargetChain(nextChain, "edges", name, null);
        for (const name of missingNodeCols)
          nextChain = retargetChain(nextChain, "nodes", name, null);
        const droppedSteps = chain.length - nextChain.length;
        const styleKeys = [
          "nodeColor",
          "nodeSize",
          "nodeImage",
          "nodeLabel",
          "edgeWidth",
          "edgeColor",
        ] as const;
        const changedChannels =
          styleKeys.filter((k) => nextStyle[k] !== style[k]).length +
          (style.typeStyles !== undefined && nextStyle.typeStyles === undefined ? 1 : 0) +
          (style.edgeTypeStyles !== undefined && nextStyle.edgeTypeStyles === undefined ? 1 : 0);

        // Everything above was computed against the tables as they stood
        // before the parse and the metrics awaited; an edit made in that
        // window must not be steamrolled by a merge that never saw it.
        if (docRef.current !== doc) {
          setError(
            'The tables changed while the update was being prepared. Run "Update data" again.',
          );
          return;
        }

        forgetUrlSource();
        // "keep": the update swaps the data under the edits; the overlay is
        // exactly what must survive it.
        editDoc("updating the data", () => final, "keep");
        setStyle(nextStyle);
        setChain(nextChain);
        setSelection(null);
        setDataset(incomingDataset ?? { fileName: file.name, tables: [final.edges, final.nodes] });
        setEdgeTableIndex(nextEdgeIndex);
        setNodeTableIndex(incomingDataset === null ? 1 : nextNodeIndex);

        const parts = [
          `Updated the data from "${file.name}": ${final.edges.rows.length.toLocaleString()} edge rows, ${final.nodes.rows.length.toLocaleString()} nodes.`,
        ];
        if (report) {
          const kept: string[] = [
            `${report.updated.toLocaleString()} rows updated`,
            `${report.added.toLocaleString()} new`,
          ];
          if (report.editsKept > 0) kept.push(`your ${report.editsKept} edits kept`);
          if (report.deletionsHeld > 0) kept.push(`${report.deletionsHeld} deletions held`);
          if (report.keptExtras > 0) {
            kept.push(
              `${report.keptExtras} edited ${report.keptExtras === 1 ? "row" : "rows"} no longer in the file (kept)`,
            );
          }
          parts.push(`${kept.join(", ")}.`);
        }
        if (droppedSteps > 0 || changedChannels > 0) {
          const what: string[] = [];
          if (droppedSteps > 0) {
            what.push(`${droppedSteps} filter ${droppedSteps === 1 ? "step" : "steps"}`);
          }
          if (changedChannels > 0) {
            what.push(`${changedChannels} style ${changedChannels === 1 ? "channel" : "channels"}`);
          }
          parts.push(`${what.join(" and ")} referenced columns not in this file.`);
        }
        if (guessedEdgeSheet !== null) {
          parts.push(
            `No sheet named "${doc.edges.name}" in this file; read "${guessedEdgeSheet}" as the edges.`,
          );
        }
        if (lostNodeSheet !== null) {
          parts.push(
            `No sheet named "${lostNodeSheet}" in this file; node attributes were derived from the edges instead.`,
          );
        }
        setNotice(parts.join(" "));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that file.");
      }
    },
    [doc, overlay, computedRuns, style, chain, nodeTableIndex, editDoc, forgetUrlSource],
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

  /** What a node is called on screen right now, for messages about it. */
  const labelFor = useCallback(
    (id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id,
    [graph],
  );

  /**
   * Light one route and count how much of it runs along the arrows. Shared
   * by the first trace and the card's route pager.
   */
  const lightRoute = useCallback(
    (path: string[], directed: boolean): number => {
      const present = new Set(
        (base?.links ?? []).map((l) => edgeKey(endpointId(l.source), endpointId(l.target))),
      );
      const nodes = new Set(path);
      const links = new Set<string>();
      let forward = 0;
      for (let i = 1; i < path.length; i++) {
        links.add(edgeKey(path[i - 1], path[i]));
        // An undirected walk can ride an edge stored the other way round.
        if (!directed) links.add(edgeKey(path[i], path[i - 1]));
        if (present.has(edgeKey(path[i - 1], path[i]))) forward++;
      }
      setPathHighlight({ nodes, links });
      return forward;
    },
    [base],
  );

  /** How many equally short routes are worth listing for the pager. */
  const ROUTE_LIMIT = 12;

  /**
   * Trace the routes and light the first. The result carries its facts: how
   * many equally short routes exist, which one is lit, and how much of it
   * runs along the arrows, since the default walk ignores them.
   */
  const tracePath = useCallback(
    (from: string, to: string, directed: boolean) => {
      if (base === null) return;
      const info = shortestRoutes(toMetricGraph(base), from, to, {
        directed,
        limit: ROUTE_LIMIT,
      });
      if (info === null) {
        setPathHighlight(null);
        setPathResult({ from, to, routes: [], count: 0, routeIndex: 0, forward: 0 });
        setLiveMessage(
          `No path between ${labelFor(from)} and ${labelFor(to)}${directed ? " along the arrows" : ""}.`,
        );
        return;
      }
      const forward = lightRoute(info.routes[0], directed);
      setPathResult({ from, to, routes: info.routes, count: info.count, routeIndex: 0, forward });
      const hops = info.routes[0].length - 1;
      setLiveMessage(
        `Path of ${hops} hop${hops === 1 ? "" : "s"} from ${labelFor(from)} to ${labelFor(to)}${
          info.count > 1 ? `, one of ${info.count} equally short routes` : ""
        }.`,
      );
    },
    [base, labelFor, lightRoute],
  );

  /** The card's pager: light another of the equally short routes. */
  const handlePickRoute = useCallback(
    (index: number) => {
      if (pathResult === null || index < 0 || index >= pathResult.routes.length) return;
      const forward = lightRoute(pathResult.routes[index], pathDirected);
      setPathResult({ ...pathResult, routeIndex: index, forward });
    },
    [pathResult, lightRoute, pathDirected],
  );

  /**
   * A selection is answered in the info panel, so picking a node or an edge
   * brings that panel out from wherever it was put away. With path mode
   * armed, picking a node is the second half of that question instead: the
   * route lights up on the filtered graph, and the far end is the answer's
   * other endpoint, not a new selection.
   */
  const handleSelect = useCallback(
    (next: GraphSelection | null) => {
      if (pathFrom !== null && next?.kind === "node" && next.id !== pathFrom && base !== null) {
        tracePath(pathFrom, next.id, pathDirected);
        setPathFrom(null);
        setSelection(null);
        setPanelOpen("stats", true);
        return;
      }
      // Clicking the background lets go of the route the way it lets go of a
      // selection; picking a node or an edge keeps the card in reach, since
      // walking the route's stops is itself a selection change. Letting go
      // also disarms the tool: Escape on a focused node arrives here as a
      // null selection, not as a keydown, and an armed tool surviving its
      // own cancellation would fire on the next Enter.
      if (next === null) {
        if (pathFrom !== null) {
          setPathFrom(null);
          setLiveMessage("Path tracing cancelled.");
        }
        setPathHighlight(null);
        setPathResult(null);
      }
      setSelection(next);
      if (next !== null) setPanelOpen("stats", true);
    },
    [setPanelOpen, pathFrom, pathDirected, base, tracePath],
  );

  /** Flipping direction re-answers the question already on screen. */
  const handlePathDirectedChange = useCallback(
    (directed: boolean) => {
      setPathDirected(directed);
      if (pathResult !== null) tracePath(pathResult.from, pathResult.to, directed);
    },
    [pathResult, tracePath],
  );

  // Filters or edits that change the structure take the route with them: the
  // path was an answer about a graph that is no longer on screen.
  useEffect(() => {
    setPathFrom(null);
    setPathHighlight(null);
    setPathResult(null);
  }, [base]);

  // A stale timeline preview is the same kind of leftover, but the base
  // cannot be its trigger: starting a preview changes the base on purpose,
  // by lifting the bound step's bounds. What actually invalidates a preview
  // is the document, the chain, or the isolated-node rule moving under it.
  // Commits clear the draft themselves before they touch the chain.
  useEffect(() => {
    timeDraftRef.current = null;
    setTimeDraftState(null);
  }, [doc, chain, showIsolated]);

  // Hiding the strip mid-preview would otherwise strand the dim on screen
  // with nothing left to explain or clear it; the committed step stays.
  useEffect(() => {
    if (hiddenOverlays.has("timeline")) {
      timeDraftRef.current = null;
      setTimeDraftState(null);
    }
  }, [hiddenOverlays]);

  const handlePathFrom = useCallback(
    (id: string) => {
      setPathFrom(id);
      setLiveMessage(
        `Tracing a path from ${labelFor(id)}: select the far end. Press Escape to cancel.`,
      );
    },
    [labelFor],
  );

  const cancelPath = useCallback(() => {
    setPathFrom(null);
    setLiveMessage("Path tracing cancelled.");
  }, []);

  const clearPath = useCallback(() => {
    setPathHighlight(null);
    setPathResult(null);
    setLiveMessage("Path cleared.");
  }, []);

  /** The node-only form, for the panels that never point at an edge. */
  const handleSelectNode = useCallback(
    (id: string | null) => handleSelect(id === null ? null : nodeSelection(id)),
    [handleSelect],
  );

  /** A find-box pick selects the node and travels the view to it. */
  const handleSearchPick = useCallback(
    (id: string) => {
      handleSelect(nodeSelection(id));
      canvasRef.current?.center(id);
    },
    [handleSelect],
  );

  const handleTogglePin = useCallback((id: string) => {
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Shift-dragging only ever pins; letting go is the panel's affordance. */
  const handlePinNode = useCallback((id: string) => {
    setPinned((current) => (current.has(id) ? current : new Set(current).add(id)));
  }, []);

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
  //
  // "Inside a field" includes a focused graph node. Single-character shortcuts
  // have to give way to whatever currently has focus (WCAG 2.1.4), and someone
  // arrowing around the network is not asking for the window to be cleared.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof Element &&
        e.target.closest("input, textarea, select, [contenteditable], [data-nodes]") !== null;
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
      } else if (e.key === "/") {
        // Focus the find box rather than typing a slash into the page.
        if (searchRef.current) {
          e.preventDefault();
          searchRef.current.focus();
        }
      } else if (e.key === "Escape") {
        // An armed path tool is the most immediate thing to let go of, then
        // a route still lit from the last trace.
        if (pathFrom !== null) cancelPath();
        else if (pathHighlight !== null || pathResult !== null) clearPath();
        else showEverything();
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
    pathFrom,
    cancelPath,
    pathHighlight,
    pathResult,
    clearPath,
  ]);

  const handleSample = useCallback(
    (network: SampleNetwork) => {
      forgetUrlSource();
      adoptDataset(network.dataset, {
        nodeTable: network.nodeTable,
        style: network.style,
        nodeAttrs: network.nodeAttrs,
      });
      // A sample that names its layout opens in it; one that does not still
      // steps off the map, which would otherwise park all of its nodes.
      const wanted = network.layout;
      if (wanted !== undefined) {
        setLayout(wanted);
        setParamsByLayout((current) => ({
          ...current,
          [wanted]: { ...defaultParams(wanted), ...network.layoutParams },
        }));
      } else {
        setLayout((current) => (current === "geo" ? "force" : current));
      }
      // A shipped sample is ours. Its images are a known list on a known CDN,
      // not somebody else's choice of who this machine should talk to.
      setAllowRemoteImages(true);
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
    setComputedRuns([]);
    setShowIsolated(false);
    setSelection(null);
    setPinned(new Set());
    setCollapsed(defaultCollapsed());
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
      adoptDoc(nextDoc, guessStyle(edges, nextDoc.mapping, nextDoc.nodes));
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
        const structural = (name: string) => name === mapping.source || name === mapping.target;
        return {
          ...s,
          nodeColor: fix(s.nodeColor, "none"),
          nodeSize: fix(s.nodeSize, "metric:degree"),
          nodeImage: fix(s.nodeImage, "none"),
          edgeWidth: fix(s.edgeWidth, "uniform"),
          edgeColor: fix(s.edgeColor, "uniform"),
          typeStyles: s.typeStyles && structural(s.typeStyles.column) ? undefined : s.typeStyles,
          edgeTypeStyles:
            s.edgeTypeStyles && structural(s.edgeTypeStyles.column) ? undefined : s.edgeTypeStyles,
        };
      });
    },
    [doc, editDoc],
  );

  const handleStyleChange = useCallback((patch: Partial<GraphStyle>) => {
    setStyle((s) => ({ ...s, ...patch }));
  }, []);

  /**
   * One-mode projection: the bipartite tables are replaced wholesale, as one
   * undo step, so the original edge list is one Ctrl+Z away. Anything the cap
   * left out is said out loud rather than passed off as the whole answer.
   */
  const handleProject = useCallback(
    (keep: ProjectionSide) => {
      if (!doc) return;
      const { doc: next, report } = projectBipartite(doc, keep);
      editDoc(`the projection onto ${keep}s`, () => next);
      // The old edge columns are gone wholesale, so steps and style tokens
      // naming them go the way they do when a named column is deleted: the
      // chain empties, and each vanished column folds through retargetStyle,
      // which spares anything the surviving node table still answers. The
      // shared count is what a projection is for, so it drives the edge
      // width from the start.
      setChain([]);
      setSelection(null);
      setStyle((s) => {
        let styled: GraphStyle = { ...s, edgeWidth: "column:Shared count" };
        for (const column of doc.edges.columns) {
          if (!hasColumn(next.edges, column.name)) {
            styled = retargetStyle(styled, next, column.name, null);
          }
        }
        return styled;
      });
      const summary = `Projected ${report.nodes} nodes into ${report.edges} shared-counterpart links.`;
      const capped =
        report.counterparts.used < report.counterparts.total
          ? ` Stopped at the pair cap: folded in ${report.counterparts.used} of ${report.counterparts.total} counterpart nodes.`
          : "";
      setNotice(summary + capped);
    },
    [doc, editDoc],
  );

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

  // Switching to the geographic layout with nothing chosen yet: number
  // columns named like coordinates are what was meant, so they are filled in
  // rather than asked for. Anything already chosen is left alone.
  useEffect(() => {
    if (layout !== "geo" || !doc) return;
    setParamsByLayout((current) => {
      const existing = current.geo;
      if (existing?.latColumn || existing?.lonColumn) return current;
      const numbers = doc.nodes.columns.filter((c) => c.type === "number");
      const lat = numbers.find((c) => /lat/i.test(c.name));
      const lon = numbers.find((c) => /^(lon|lng|long)/i.test(c.name) || /longitude/i.test(c.name));
      if (!lat || !lon) return current;
      return {
        ...current,
        geo: { ...defaultParams("geo"), ...existing, latColumn: lat.name, lonColumn: lon.name },
      };
    });
  }, [layout, doc]);

  // What the map could not place is said, never silently parked: the strip
  // below the extent holds the nodes, this holds the explanation.
  useEffect(() => {
    if (layout !== "geo" || !base) return;
    const latColumn = typeof layoutParams.latColumn === "string" ? layoutParams.latColumn : "";
    const lonColumn = typeof layoutParams.lonColumn === "string" ? layoutParams.lonColumn : "";
    if (latColumn === "" || lonColumn === "") {
      setNotice("Choose the latitude and longitude columns for the geographic layout.");
      return;
    }
    const { parked } = projectGeo(base, latColumn, lonColumn);
    if (parked.length > 0) {
      setNotice(
        `${parked.length} ${parked.length === 1 ? "node has" : "nodes have"} no usable coordinates and sit in the strip below the map.`,
      );
    }
  }, [layout, layoutParams, base]);

  /**
   * Metrics run over the graph as currently filtered, matching what the user
   * can see, and land in the document as computed columns.
   */
  const handleCompute = useCallback(
    async (metrics: string[], options: MetricOptions) => {
      if (!base) throw new Error("Load data before computing metrics.");
      const run = await computeMetrics(toMetricGraph(base, options.weightColumn), metrics, options);
      editDoc("computing metrics", (current) => applyComputedColumns(current, run.result));
      // Remember the instruction, not just the values: the recipe half of
      // the workspace, replayed by "update data". Identical runs fold.
      setComputedRuns((current) => {
        const entry: ComputedRecipe = { metrics, options };
        const key = JSON.stringify(entry);
        return [...current.filter((r) => JSON.stringify(r) !== key), entry];
      });
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
    setComputedRuns([]);
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
   * Hop distances from the selected node, written as an ordinary computed
   * column: the heat-map tool done the columns way, so color ramps, sizes and
   * range filters all compose with the answer without knowing it is special.
   */
  const handleDistancesFrom = useCallback(
    (id: string) => {
      if (!base || !doc) return;
      const name = `Hops from ${labelFor(id)}`;
      const column = hopsColumn(toMetricGraph(base), id, name);
      if (!column) return;
      editDoc(`writing "${name}"`, (current) =>
        applyComputedColumns(current, { nodeColumns: [column], edgeColumns: [], summary: {} }),
      );
      handleShowColumns("nodes");
      setLiveMessage(`Wrote "${name}" onto the node table.`);
    },
    [base, doc, labelFor, editDoc, handleShowColumns],
  );

  /**
   * Progressive exploration: growing the view from the selection is adding
   * the selected node to the centers of the last enabled ego step, which is
   * an ordinary chain step, so reordering, disabling, undo and share links
   * all keep working. With no ego step in the chain the first expansion
   * starts one, a single hop wide.
   */
  const lastEgo = useMemo(() => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i];
      if (step.kind === "ego" && step.enabled) return step;
    }
    return null;
  }, [chain]);

  const handleExpandFrom = useCallback((id: string) => {
    setChain((current) => {
      for (let i = current.length - 1; i >= 0; i--) {
        const step = current[i];
        if (step.kind === "ego" && step.enabled) {
          if (step.centers.includes(id)) return current;
          return current.map((s) =>
            s.id === step.id && s.kind === "ego" ? { ...s, centers: [...s.centers, id] } : s,
          );
        }
      }
      return [
        ...current,
        { id: newStepId(), enabled: true, kind: "ego", centers: [id], depth: 1, direction: "any" },
      ];
    });
  }, []);

  /** The way back out of an exploration: the ego step comes off the chain. */
  const handleClearExpand = useCallback(() => {
    setChain((current) => {
      for (let i = current.length - 1; i >= 0; i--) {
        const step = current[i];
        if (step.kind === "ego" && step.enabled) {
          return current.filter((s) => s.id !== step.id);
        }
      }
      return current;
    });
  }, []);

  /**
   * Whether the selected node already has its distances written, so the
   * button can offer the way back: deleting the column it wrote.
   */
  const distancesColumn = useMemo(() => {
    if (!doc || selectedId === null) return null;
    const name = `Hops from ${labelFor(selectedId)}`;
    const column = doc.nodes.columns.find((c) => c.computed && c.name === name);
    return column?.name ?? null;
  }, [doc, selectedId, labelFor]);

  const handleEgoDepthChange = useCallback((depth: number) => {
    const clamped = Math.max(1, Math.min(6, depth));
    setChain((current) => {
      for (let i = current.length - 1; i >= 0; i--) {
        const step = current[i];
        if (step.kind === "ego" && step.enabled) {
          return current.map((s) => (s.id === step.id ? { ...s, depth: clamped } : s));
        }
      }
      return current;
    });
  }, []);

  /**
   * The timeline. Its strip is an editor for one ordinary chain step, kind
   * "timewindow", bound the way the exploration binds its ego step: the last
   * enabled one. The window state itself lives above the chain memo, since a
   * preview lifts the bound step's committed bounds.
   */
  const handleTimePreview = useCallback((window: TimeWindow) => {
    timeDraftRef.current = window;
    setTimeDraftState(window);
  }, []);

  const handleTimeCommit = useCallback(() => {
    const draft = timeDraftRef.current;
    timeDraftRef.current = null;
    setTimeDraftState(null);
    if (draft === null) return;
    setChain((current) => {
      for (let i = current.length - 1; i >= 0; i--) {
        const step = current[i];
        if (step.kind === "timewindow" && step.enabled) {
          return current.map((s) =>
            s.id === step.id ? { ...s, min: draft.min, max: draft.max } : s,
          );
        }
      }
      return current;
    });
  }, []);

  const handleTimeColumn = useCallback((option: TimeColumnOption | null) => {
    timeDraftRef.current = null;
    setTimeDraftState(null);
    setChain((current) => {
      for (let i = current.length - 1; i >= 0; i--) {
        const step = current[i];
        if (step.kind === "timewindow" && step.enabled) {
          if (option === null) return current.filter((s) => s.id !== step.id);
          return current.map((s) =>
            s.id === step.id
              ? { ...s, table: option.table, column: option.column, min: null, max: null }
              : s,
          );
        }
      }
      if (option === null) return current;
      return [
        ...current,
        {
          id: newStepId(),
          enabled: true,
          kind: "timewindow",
          table: option.table,
          column: option.column,
          min: null,
          max: null,
        },
      ];
    });
  }, []);

  const timeOptions = useMemo(() => (doc ? timeColumns(doc) : []), [doc]);

  /** The in-flight window as dimming, computed over the visible subgraph. */
  const timelineDim = useMemo<MarkSet | null>(() => {
    if (timeDraft === null || lastTimewindow === null || base === null) return null;
    const { column, table } = lastTimewindow;
    const { min, max } = timeDraft;
    if (min === null && max === null) return null;
    const inside = (v: CellValue): boolean => {
      const t = asTime(v);
      if (t === null) return false;
      if (min !== null && t < min) return false;
      if (max !== null && t > max) return false;
      return true;
    };
    const nodes = new Set<string>();
    const links = new Set<string>();
    if (table === "edges") {
      const lit = new Set<string>();
      const touched = new Set<string>();
      for (const link of base.links) {
        const s = endpointId(link.source);
        const t = endpointId(link.target);
        touched.add(s);
        touched.add(t);
        if (link.rows.some((r) => inside(r[column]))) {
          lit.add(s);
          lit.add(t);
        } else {
          links.add(edgeKey(s, t));
        }
      }
      // A node fades when every edge it had fades; one that never had any is
      // the isolated case, which the committed filter would leave alone too.
      for (const node of base.nodes) {
        if (touched.has(node.id) && !lit.has(node.id)) nodes.add(node.id);
      }
    } else {
      for (const node of base.nodes) {
        if (!inside(node.row[column])) nodes.add(node.id);
      }
      for (const link of base.links) {
        const s = endpointId(link.source);
        const t = endpointId(link.target);
        if (nodes.has(s) || nodes.has(t)) links.add(edgeKey(s, t));
      }
    }
    return { nodes, links };
  }, [timeDraft, lastTimewindow, base]);

  /**
   * The expansion preview's line checkboxes write the same `where` the Filter
   * step's own editor writes, on the same ego step, so the two views of the
   * exploration cannot disagree about which edges are walked.
   */
  const handleEgoWhereChange = useCallback(
    (where: { column: string; values: string[] } | undefined) => {
      setChain((current) => {
        for (let i = current.length - 1; i >= 0; i--) {
          const step = current[i];
          if (step.kind === "ego" && step.enabled) {
            return current.map((s) => {
              if (s.id !== step.id || s.kind !== "ego") return s;
              if (where === undefined) {
                const { where: _dropped, ...rest } = s;
                return rest;
              }
              return { ...s, where };
            });
          }
        }
        return current;
      });
    },
    [],
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
      pinned: [...pinned],
      computed: computedRuns,
      edits: overlay,
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
    pinned,
    computedRuns,
    overlay,
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

  const appUrl = embed?.appUrl;
  /**
   * The HTML export inlines a bundle built beside the app. Served as a page it
   * sits next to the other assets; embedded there is no "beside us", so it is
   * fetched from wherever the app itself lives.
   */
  const handleExportHtml = useCallback(async () => {
    const input = exportInput();
    if (!input) return;
    try {
      const bundleUrl = appUrl
        ? new URL("standalone.js", appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString()
        : `${import.meta.env.BASE_URL}standalone.js`;
      downloadText(await exportHtml(input, { bundleUrl, appUrl }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the HTML file.");
    }
  }, [exportInput, appUrl]);

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

  // What one mark's tooltip lists. Functions rather than lists, because a
  // typed mark can choose its own details; the canvas just asks.
  const nodeAttrsFor = useCallback(
    (d: GraphNode): Column[] => (doc ? nodeDetailColumnsFor(doc, style, d.row) : []),
    [doc, style],
  );
  const edgeAttrsFor = useCallback(
    (l: GraphLink): string[] => (doc ? edgeDetailColumnsFor(doc, style, l.rows) : []),
    [doc, style],
  );

  const visibleRows = useMemo(() => new Set(base?.rows ?? []), [base]);
  const visibleNodeIds = useMemo(() => new Set((base?.nodes ?? []).map((n) => n.id)), [base]);

  const colorColumn = styleColumn(style.nodeColor);
  const showLegend = graph !== null && hasLegend(graph);

  /**
   * How many distinct web addresses the current graph would like this machine
   * to fetch pictures from. Counted rather than merely detected, because "42
   * images" and "one image" are different questions to be asked.
   */
  const heldBackImages = useMemo(() => {
    if (graph === null || allowRemoteImages) return 0;
    const sources = new Set<string>();
    for (const node of graph.nodes) {
      if (node.image !== null && isRemoteSource(node.image)) sources.add(node.image);
    }
    return sources.size;
  }, [graph, allowRemoteImages]);

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
      // `app-empty` is the onboarding showing rather than a graph. Narrow, that
      // is the whole window, and the tabs that would open panels with nothing
      // in them yet go away with it.
      className={`app${doc === null ? " app-empty" : ""}${
        sidebarCollapsed ? " app-sidebar-collapsed" : ""
      }${tableCollapsed ? " app-table-collapsed" : ""}${
        statsCollapsed ? " app-stats-collapsed" : ""
      }`}
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
        colors={colors}
        edgeColors={edgeColors}
        selectedId={selectedId}
        showIsolated={showIsolated}
        visible={!sidebarCollapsed}
        layout={layout}
        layoutParams={layoutParams}
        preventOverlap={preventOverlap}
        labelMode={labelMode}
        nodeStyleScope={nodeStyleScope}
        edgeStyleScope={edgeStyleScope}
        onNodeStyleScopeChange={setNodeStyleScope}
        onEdgeStyleScopeChange={setEdgeStyleScope}
        onFile={(f) => void handleFile(f)}
        onUpdateFile={(f) => void handleUpdateFile(f)}
        onSample={handleSample}
        onClear={handleClear}
        onTableChange={handleTableChange}
        onMappingChange={handleMappingChange}
        onProject={handleProject}
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
        onTidyLabels={() => canvasRef.current?.tidyLabels()}
        onLabelModeChange={setLabelMode}
        onExport={(f) => void handleExport(f)}
        onExportData={handleExportData}
        onExportHtml={() => void handleExportHtml()}
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
        {sidebarCollapsed && <span className="panel-toggle-label">Graph</span>}
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
          {tableCollapsed && <span className="panel-toggle-label">Data</span>}
        </button>
      )}

      {/* And once more, mirrored, on the statistics panel's edge. */}
      {graph && doc && (
        <button
          type="button"
          className="panel-toggle stats-toggle"
          onClick={() => togglePanel("stats")}
          aria-expanded={!statsCollapsed}
          title={statsCollapsed ? "Show the info panel" : "Hide the info panel"}
          aria-label={statsCollapsed ? "Show the info panel" : "Hide the info panel"}
        >
          <span className="panel-toggle-arrow" aria-hidden="true">
            {statsCollapsed ? "‹" : "›"}
          </span>
          {statsCollapsed && <span className="panel-toggle-label">Info</span>}
        </button>
      )}

      <div className="workspace">
        <main className="stage">
          {graph && base && doc ? (
            <>
              <GraphCanvas
                ref={canvasRef}
                graph={graph}
                base={base}
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
                edgeAttrsFor={edgeAttrsFor}
                nodeAttrsFor={nodeAttrsFor}
                selection={selection}
                onSelect={handleSelect}
                highlightPath={pathHighlight}
                dimmed={timelineDim}
                seedPositions={seedPositionsRef}
                allowRemoteImages={allowRemoteImages}
                pinned={pinned}
                onPinNode={handlePinNode}
                reducedMotion={reducedMotion}
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
                  <NodeSearch
                    graph={graph}
                    corner={toolbarCorner}
                    onPick={handleSearchPick}
                    inputRef={searchRef}
                  />
                  <span className="tool-sep" aria-hidden="true" />
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
                    timelineAvailable={timeOptions.length > 0}
                    theme={themePref}
                    onThemeChange={setThemePref}
                    motion={motionPref}
                    onMotionChange={setMotionPref}
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
              {timeOptions.length > 0 && !hiddenOverlays.has("timeline") && (
                <Timeline
                  doc={doc}
                  options={timeOptions}
                  step={lastTimewindow}
                  draft={timeDraft}
                  corner={timelineCorner}
                  onCornerChange={setTimelineCorner}
                  onPickColumn={handleTimeColumn}
                  onPreview={handleTimePreview}
                  onCommit={handleTimeCommit}
                  onHide={() => setOverlayVisible("timeline", false)}
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
                base={AMBIENT_BASE}
                layout="force"
                layoutParams={{}}
                preventOverlap={false}
                labelMode="none"
                style={AMBIENT_STYLE}
                colors={AMBIENT_COLORS}
                theme={graphTheme}
                edgeColors={new Map()}
                selection={null}
                onSelect={() => {}}
                ambient
                reducedMotion={reducedMotion}
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
                  {/* The illustration is four columns of names that must not
                      wrap, so on a narrow screen it scrolls rather than
                      losing the shape it is there to show. */}
                  <div className="example-scroll">
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
                  </div>
                  <p className="example-caption">
                    Any column names work; you pick which is which after loading.
                  </p>
                  <button type="button" className="dropzone" onClick={pickAnyFile}>
                    <strong>Drop a file here or click to browse</strong>
                    <span className="hint">
                      .csv · .xlsx · .parquet · .json · .gexf · .graphml · .dot
                    </span>
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
                  {/* The last way in that is not a file. It lives here as well
                      as in the sidebar because on a narrow screen this card is
                      the whole app: the sidebar is not reachable until there is
                      something for its other steps to work on. */}
                  <p className="example-caption">Or load a GitHub gist:</p>
                  <GistLoad onLoad={(reference) => void handleGist(reference)} />
                </div>
              </div>
            </>
          )}
          {(error || notice || heldBackImages > 0) && (
            <div className="toast-stack">
              {heldBackImages > 0 && (
                <div className="toast" role="status">
                  <span>
                    This graph points at {heldBackImages}{" "}
                    {heldBackImages === 1 ? "picture" : "pictures"} on the web. Loading{" "}
                    {heldBackImages === 1 ? "it" : "them"} tells{" "}
                    {heldBackImages === 1 ? "that site" : "those sites"} you opened this graph.
                  </span>
                  <button
                    type="button"
                    className="toast-action"
                    onClick={() => setAllowRemoteImages(true)}
                  >
                    Load images
                  </button>
                </div>
              )}
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
          {/* Announcements from the path and distance tools, which answer
              without moving focus anywhere a screen reader would follow. */}
          <div className="visually-hidden" role="status" aria-live="polite">
            {liveMessage}
          </div>
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
          when it is put away rather than being covered by it. It takes both
          graphs: the styled one to read colours off, and the structural one it
          counts, which is the same network whatever the styling says. */}
      {graph && base && doc && (
        <>
          <div
            className="resizer resizer-stats"
            aria-label="Info panel width"
            {...stats.handleProps}
          />
          <StatsPanel
            doc={doc}
            rows={filteredRows}
            totalRows={doc.edges.rows.length}
            graph={graph}
            style={style}
            base={base}
            colorColumn={graph.ranking ? null : colorColumn}
            palette={palette}
            colors={colors}
            edgeColors={edgeColors}
            chain={chain}
            selection={selection}
            pinned={pinned}
            onTogglePin={handleTogglePin}
            allowRemoteImages={allowRemoteImages}
            egoDepth={lastEgo?.depth ?? null}
            onExpandFrom={handleExpandFrom}
            onEgoDepthChange={handleEgoDepthChange}
            onClearExpand={handleClearExpand}
            egoWhere={lastEgo?.where}
            onEgoWhereChange={handleEgoWhereChange}
            pathArmed={pathFrom !== null}
            onPathFrom={handlePathFrom}
            onCancelPath={cancelPath}
            onDistancesFrom={handleDistancesFrom}
            distancesColumn={distancesColumn}
            onRemoveDistances={(column) => handleDeleteColumn("nodes", column)}
            pathResult={pathResult}
            pathDirected={pathDirected}
            onPathDirectedChange={handlePathDirectedChange}
            onPickRoute={handlePickRoute}
            onClearPath={clearPath}
            onToggleValueFilter={handleToggleValueFilter}
            onSelectNode={handleSelectNode}
            onClose={() => setPanelOpen("stats", false)}
          />
        </>
      )}
    </div>
  );
}
