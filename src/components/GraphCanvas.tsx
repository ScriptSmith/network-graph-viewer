import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import type {
  BaseGraph,
  Column,
  Graph,
  GraphLink,
  GraphNode,
  GraphStyle,
  LabelMode,
  Row,
  GraphSelection,
} from "../types";
import { isCellStyle } from "../types";
import {
  computeTargets,
  forceAtlas2,
  forceAtlas2Params,
  labelNoverlap,
  layoutWeightColumn,
  noverlap,
  type LayoutId,
  type LayoutParams,
} from "../lib/layouts";
import { endpointId as endpoint, weightScale } from "../lib/graph";
import { isRemoteSource } from "../lib/images";
import { contentBounds, type ExportBox } from "../lib/export";
import { displayCell, formatMetric } from "../lib/format";
import { DEFAULT_COLORS, type GraphTheme, type Palette } from "../theme";
import type {
  MarkSet,
  RendererCallbacks,
  RendererHandle,
  RendererId,
  SharedScene,
  ViewState,
} from "../render";
import { paintScene } from "../render";
import { linkKeyOf } from "../render/appearance";
import { SvgScene } from "../render/SvgScene";
import { CanvasScene } from "../render/CanvasScene";
import { WebglScene } from "../render/WebglScene";

export type { MarkSet } from "../render";

/** A route to light up: its nodes, and its links by `edgeKey` in both directions. */
export type PathHighlight = MarkSet;

export interface GraphCanvasHandle {
  fit: () => void;
  reheat: () => void;
  /** Nudge overlapping nodes apart in place, leaving the layout otherwise alone. */
  separate: () => void;
  /** The same nudge, but against the visible labels' estimated boxes. */
  tidyLabels: () => void;
  /** Travel to one node and put it in the middle at a readable scale. */
  center: (id: string) => void;
  /** The scene as a standalone SVG, or null under a renderer that cannot say. */
  buildExport: () => { svgText: string; box: ExportBox } | null;
  /** The scene painted afresh at export scale, under any renderer. */
  exportPng: () => Promise<Blob | null>;
  /** Hold the layout simulation where it stands, whoever is running it. */
  pauseLayout: () => void;
  /** Set it moving again from where it stopped. */
  resumeLayout: () => void;
}

interface GraphCanvasProps {
  /**
   * The graph with its appearance resolved: colours, radii, images, weights.
   * A new object every time any style setting changes.
   */
  graph: Graph;
  /**
   * The same graph before styling, which changes only when the network does.
   *
   * The two are separate props because they answer different questions. Whether
   * the scene has to be rebuilt, the simulation replaced and the view refitted
   * is a question about `base`; whether the marks need repainting is a question
   * about `graph`. Keying the rebuild on `graph` meant that picking a different
   * palette threw away the simulation and re-ran the physics, and the graph
   * visibly flew apart to arrive at the same layout in different colours.
   */
  base: BaseGraph;
  /**
   * Which painter draws the marks. The scene, the simulation and the keyboard
   * live here whichever is chosen; switching repaints the same layout through
   * a different renderer without reheating anything.
   */
  renderer?: RendererId;
  layout: LayoutId;
  layoutParams: LayoutParams;
  /** Targets for the "script" layout, produced by a user layout script. */
  scriptedTargets?: Map<string, { x: number; y: number }> | null;
  preventOverlap: boolean;
  labelMode: LabelMode;
  style: GraphStyle;
  /** Resolved color sets, so the palette the user picked reaches every mark. */
  palette?: Palette;
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  /** The colours the marks are drawn with. Values, not a stylesheet: an
   *  exported SVG carries its own attributes and no CSS at all. */
  theme: GraphTheme;
  /**
   * What one edge's tooltip lists. A function rather than a list, because a
   * typed edge can choose its own details; the app compiles the answer.
   */
  edgeAttrsFor?: (l: GraphLink) => string[];
  /** The node side of the same question. */
  nodeAttrsFor?: (d: GraphNode) => Column[];
  selection: GraphSelection | null;
  onSelect: (next: GraphSelection | null) => void;
  /**
   * A shortest path to light: painted like hover and selection are, through
   * the restyle path, attributes only, never a scene rebuild.
   */
  highlightPath?: PathHighlight | null;
  /**
   * Marks faded out by the timeline's in-flight window: appearance only, so
   * scrubbing and playback never rebuild the scene. Committing the window to
   * the chain is what changes the structure, and that happens on release.
   */
  dimmed?: MarkSet | null;
  /**
   * Whether node images may be fetched from the web. Off until the reader says
   * otherwise: an image cell in a shared graph is a request to somebody else's
   * server, made from the reader's machine, chosen by whoever wrote the link.
   * Data URIs and inline SVG are unaffected, being part of the graph already.
   */
  allowRemoteImages?: boolean;
  /**
   * Nodes held at their positions whatever layout is running. The simulation
   * side of the pin; the set itself lives with the app so it can be saved.
   */
  pinned?: ReadonlySet<string>;
  /** Called when a shift-drag pins a node; plain drags never do. */
  onPinNode?: (id: string) => void;
  /**
   * The chosen renderer could not start after all: WebGL2 probed fine but the
   * device failed. The app answers by choosing something that works.
   */
  onRendererFailed?: () => void;
  /**
   * The layout simulation started or stopped, whichever engine is running it.
   * The toolbar's pause control shows and hides on this.
   */
  onSimulationRunning?: (running: boolean) => void;
  /**
   * Positions to seed the next scene with, consumed once. Used when a node is
   * dropped on the canvas and when a file arrives carrying a layout.
   */
  seedPositions?: RefObject<Map<string, { x: number; y: number }> | null>;
  ambient?: boolean;
  /**
   * Whether to skip the movement that is decoration: layouts settle instead of
   * being watched, the view jumps instead of easing. Resolved by the app from
   * the system preference and the View menu's override, so the canvas takes
   * one answer rather than asking the media query itself.
   */
  reducedMotion?: boolean;
  ref?: Ref<GraphCanvasHandle>;
}

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * How big a graph will still be settled in one go for a reader who asked for
 * less movement, and how many steps that takes. The tick count is roughly where
 * d3's default decay has the simulation cool anyway.
 */
const SETTLE_LIMIT = 2000;
const SETTLE_TICKS = 200;

/** The widest a PNG export will paint, whatever the scene's extent asks for. */
const PNG_MAX_PIXELS = 8192;

const EMPTY_PINNED: ReadonlySet<string> = new Set();
const NO_EDGE_ATTRS = (): string[] => [];
const NO_NODE_ATTRS = (): Column[] => [];

export function GraphCanvas({
  graph,
  base,
  renderer = "svg",
  layout,
  layoutParams,
  scriptedTargets,
  preventOverlap,
  labelMode,
  style,
  palette = DEFAULT_COLORS,
  colors,
  edgeColors,
  theme,
  edgeAttrsFor = NO_EDGE_ATTRS,
  nodeAttrsFor = NO_NODE_ATTRS,
  selection,
  onSelect,
  highlightPath = null,
  dimmed = null,
  seedPositions,
  allowRemoteImages = false,
  pinned = EMPTY_PINNED,
  onPinNode,
  onRendererFailed,
  onSimulationRunning,
  ambient = false,
  reducedMotion: reducedMotionProp = false,
  ref,
}: GraphCanvasProps) {
  const selectedId = selection?.kind === "node" ? selection.id : null;
  const selectedEdge = selection?.kind === "edge" ? selection : null;
  // The ambient backdrop is a handful of marks and no interaction, so the SVG
  // renderer is always the right painter for it.
  const activeRenderer: RendererId = ambient ? "svg" : renderer;
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RendererHandle>(null);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  /** The camera as the live renderer last reported it, so a swap keeps the view. */
  const cameraRef = useRef<{ x: number; y: number; k: number } | null>(null);
  /**
   * The base whose scene was built from seed positions. Seeds are consumed on
   * first use, but StrictMode re-runs the build effect with the same base and
   * the positions surviving on the nodes; remembering the base keeps the
   * second run as cold as the first, or it would reheat and destroy the
   * arrangement the seeds carried.
   */
  const seededBaseRef = useRef<BaseGraph | null>(null);
  /**
   * Set for the commit that rebuilds the scene, cleared by the last effect of
   * that same commit. Loading a document changes the pinned set, the layout
   * parameters and the spacing along with the network, and each has an effect
   * that reheats the simulation; the rebuild applied all of them itself, so
   * those effects firing in its commit would only redo, and for a document
   * that arrived with positions destroy, what was just built.
   */
  const justBuiltRef = useRef(false);
  const baseLabelsRef = useRef<Set<string>>(new Set());
  const hoverNodeRef = useRef<string | null>(null);
  const hoverLinkRef = useRef<GraphLink | null>(null);
  /** Whether the live renderer is the one running the physics right now. */
  const rendererOwnedSimRef = useRef(false);
  /** Paint the marks at the positions the simulation currently holds. */
  const drawRef = useRef<() => void>(() => {});

  const edgeWidth = useMemo(
    () => weightScale(graph.links, isCellStyle(style.edgeWidth), style.edgeWidthCurve ?? "sqrt"),
    [graph, style.edgeWidth, style.edgeWidthCurve],
  );

  /**
   * One arrow marker per stroke color in play: the palette's slots, plus
   * whatever colors the edges brought with them from their own column.
   */
  const arrowColors = useMemo(() => {
    const list = [...palette.categorical];
    for (const l of graph.links) {
      if (l.color !== null && !list.includes(l.color)) list.push(l.color);
    }
    return list;
  }, [graph, palette]);

  // Sources that turned out not to load: a dead link would otherwise leave the
  // browser's broken-image glyph sitting inside the node.
  const [brokenImages, setBrokenImages] = useState<ReadonlySet<string>>(() => new Set());
  const probedImages = useRef<Set<string>>(new Set());
  // The decoded pixels per source, for the painters that draw rather than
  // reference: a canvas cannot name a URL the way an SVG pattern can.
  const imageElsRef = useRef<Map<string, HTMLImageElement>>(new Map());

  /**
   * Whether a source is one this canvas will actually draw: not broken, and
   * not waiting on permission to leave the machine.
   */
  const drawable = (source: string | null): source is string =>
    source !== null && !brokenImages.has(source) && (allowRemoteImages || !isRemoteSource(source));

  /**
   * A pattern per distinct image, not per node: a pattern in bounding-box units
   * sizes itself to whichever circle carries it, so one definition serves every
   * node sharing a picture whatever radius each ended up with.
   */
  const imagePatterns = useMemo(() => {
    const ids = new Map<string, string>();
    for (const node of graph.nodes) {
      if (drawable(node.image) && !ids.has(node.image)) {
        ids.set(node.image, `node-image-${ids.size}`);
      }
    }
    return ids;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, brokenImages, allowRemoteImages]);

  // Each source is tried once, in an image of its own. Anything that fails
  // drops its pattern and the node falls back to its color. A source waiting
  // on permission is not probed either: the probe is the request.
  useEffect(() => {
    for (const node of graph.nodes) {
      const source = node.image;
      if (!drawable(source) || probedImages.current.has(source)) continue;
      probedImages.current.add(source);
      const probe = new Image();
      // Nothing about which graph is open is any of the far end's business.
      probe.referrerPolicy = "no-referrer";
      probe.onerror = () => {
        setBrokenImages((current) => new Set(current).add(source));
      };
      probe.onload = () => {
        // The raster renderers draw the pixels themselves, so the arrival of
        // a picture is a repaint.
        imageElsRef.current.set(source, probe);
        rendererRef.current?.restyle();
      };
      probe.src = source;
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, allowRemoteImages]);

  // Live values for callbacks created inside effects.
  const liveRef = useRef({
    layout,
    layoutParams,
    scriptedTargets,
    preventOverlap,
    labelMode,
    selectedId,
    selectedEdge,
    onSelect,
    palette,
    colors,
    edgeColors,
    edgeAttrsFor,
    nodeAttrsFor,
    ambient,
    style,
    brokenImages,
    allowRemoteImages,
    pinned,
    onPinNode,
    theme,
    highlightPath,
    dimmed,
    edgeWidth,
    imagePatterns,
    onSimulationRunning,
  });
  liveRef.current = {
    layout,
    layoutParams,
    scriptedTargets,
    preventOverlap,
    labelMode,
    selectedId,
    selectedEdge,
    onSelect,
    palette,
    colors,
    edgeColors,
    edgeAttrsFor,
    nodeAttrsFor,
    ambient,
    style,
    brokenImages,
    allowRemoteImages,
    pinned,
    onPinNode,
    theme,
    highlightPath,
    dimmed,
    edgeWidth,
    imagePatterns,
    onSimulationRunning,
  };

  /* ---- Reaching the graph from the keyboard ---- */

  /**
   * A graph is not a list, and tabbing through one node at a time would be a
   * poor way to read even a small one. So there are two movements, and no mode
   * to be in: left and right walk every node in turn, most connected first,
   * which is a tour of the graph; up and down walk the neighbours of wherever
   * you are, which is the structure itself. Enter selects, Escape lets go.
   *
   * Under the SVG renderer focus is a real DOM focus on a real circle, so the
   * browser's own focus ring and a screen reader's own reporting both work.
   * The raster renderers keep the same model on their one focusable surface
   * and draw the ring themselves.
   */
  const orderRef = useRef<string[]>([]);
  const neighborListRef = useRef<Map<string, string[]>>(new Map());
  const focusedIdRef = useRef<string | null>(null);
  const liveRegionRef = useRef<HTMLDivElement>(null);
  // As a ref, the way the other live values are: handlers installed once read
  // it when they run, and a re-render in between is neither needed nor wanted.
  const reducedMotion = useRef(reducedMotionProp);
  reducedMotion.current = reducedMotionProp;

  /** Say something once, for whoever is listening rather than looking. */
  const announce = (message: string): void => {
    const region = liveRegionRef.current;
    if (region) region.textContent = message;
  };

  const describeNode = (d: GraphNode): string => {
    const neighbors = neighborListRef.current.get(d.id)?.length ?? 0;
    const parts = [d.label];
    if (d.label !== d.id) parts.push(d.id);
    if (d.group !== null) parts.push(d.group);
    if (graph.ranking && d.value !== null) parts.push(formatMetric(d.value));
    if (liveRef.current.pinned.has(d.id)) parts.push("pinned");
    parts.push(`${d.inDegree} in, ${d.outDegree} out`);
    parts.push(neighbors === 1 ? "1 neighbour" : `${neighbors} neighbours`);
    return parts.join(", ");
  };

  // The stable shared object below reads through these refs, so the freshest
  // closures win without the object itself ever changing identity.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const drawableRef = useRef(drawable);
  drawableRef.current = drawable;
  const describeNodeRef = useRef(describeNode);
  describeNodeRef.current = describeNode;

  /**
   * Everything the renderers share: the scene, the way to read the current
   * appearance, and the callbacks that carry interaction back up. One object
   * for the component's whole life, mutated rather than replaced, because a
   * renderer holds it in handlers installed once.
   */
  /**
   * One voice for "the layout is moving", whichever engine moves it: the d3
   * simulation's restarts and end event, or the WebGL renderer's own
   * lifecycle. The ambient backdrop never speaks; its drifting is decoration,
   * not a layout anyone would pause.
   */
  const notifyRunning = (running: boolean) => {
    if (liveRef.current.ambient) return;
    liveRef.current.onSimulationRunning?.(running);
  };

  const [shared] = useState<SharedScene>(() => {
    const view = (): ViewState => {
      const live = liveRef.current;
      const focus = hoverNodeRef.current ?? live.selectedId;
      return {
        theme: live.theme,
        palette: live.palette,
        colors: live.colors,
        edgeColors: live.edgeColors,
        ranking: graphRef.current.ranking,
        arrows: live.style.arrows,
        layout: live.layout,
        selectedId: live.selectedId,
        selectedEdge:
          live.selectedEdge === null
            ? null
            : { source: live.selectedEdge.source, target: live.selectedEdge.target },
        focusId: focus,
        neighbors: focus ? (adjacencyRef.current.get(focus) ?? null) : null,
        hoverLink: hoverLinkRef.current,
        keyboardFocusId: focusedIdRef.current,
        path: live.highlightPath,
        dimmed: live.dimmed,
        pinned: live.pinned,
        baseLabels: baseLabelsRef.current,
        strokeWidth: (l) => l.width ?? live.edgeWidth(l),
        drawable: (source): source is string => drawableRef.current(source),
        imagePatterns: live.imagePatterns,
        images: imageElsRef.current,
      };
    };
    const callbacks: RendererCallbacks = {
      onSelect: (next) => liveRef.current.onSelect(next),
      onHoverNode: (d, event) => {
        const changed = hoverNodeRef.current !== (d?.id ?? null);
        hoverNodeRef.current = d?.id ?? null;
        if (changed) rendererRef.current?.restyle();
        if (d && event) showTooltipRef.current(event, nodeTooltipRef.current(d));
        if (!d && changed) hideTooltipRef.current();
      },
      onHoverLink: (l, event) => {
        const changed = hoverLinkRef.current !== l;
        hoverLinkRef.current = l;
        if (changed) rendererRef.current?.restyle();
        if (l && event) showTooltipRef.current(event, linkTooltipRef.current(l));
        if (!l && changed) hideTooltipRef.current();
      },
      onNodeKeyDown: (event, d) => onNodeKeyDownRef.current(event, d),
      onNodeFocus: (d) => focusNodeRef.current(d.id, { move: false }),
      onNodeBlur: () => {
        hoverNodeRef.current = null;
        hideTooltipRef.current();
        rendererRef.current?.restyle();
      },
      onDragStart: (d) => {
        disarmSettleFit();
        hideTooltipRef.current();
        // Under a renderer-owned simulation the renderer moves the node; our
        // stopped simulation must not be reheated to fight it.
        if (rendererRef.current?.runsSimulation?.(liveRef.current.layout)) return;
        simRef.current?.alphaTarget(0.25).restart();
        notifyRunning(true);
        d.fx = d.x;
        d.fy = d.y;
      },
      onDragMove: (d, x, y) => {
        if (rendererRef.current?.runsSimulation?.(liveRef.current.layout)) {
          d.x = x;
          d.y = y;
          return;
        }
        d.fx = x;
        d.fy = y;
      },
      onDragEnd: (d, x, y, pin) => {
        if (rendererRef.current?.runsSimulation?.(liveRef.current.layout)) {
          d.x = x;
          d.y = y;
          if (pin && !liveRef.current.pinned.has(d.id)) liveRef.current.onPinNode?.(d.id);
          return;
        }
        simRef.current?.alphaTarget(0);
        if (liveRef.current.pinned.has(d.id) || pin) {
          // Pinned, or being pinned: the dropped spot is the point.
          d.fx = x;
          d.fy = y;
          d.tx = x;
          d.ty = y;
          if (!liveRef.current.pinned.has(d.id)) liveRef.current.onPinNode?.(d.id);
        } else if (liveRef.current.layout === "force" || liveRef.current.layout === "forceatlas2") {
          d.fx = null;
          d.fy = null;
        } else {
          // In static layouts a dragged node keeps its dropped spot.
          d.tx = x;
          d.ty = y;
          d.fx = null;
          d.fy = null;
        }
      },
      onUserCamera: () => disarmSettleFit(),
      onSimulationState: (running) => notifyRunning(running),
      onCameraChange: (t) => {
        cameraRef.current = { x: t.x, y: t.y, k: t.k };
      },
      onBackgroundClick: () => liveRef.current.onSelect(null),
      onBackgroundDblClick: () => fitRef.current(600),
    };
    return {
      scene: { nodes: [], links: [] },
      view,
      callbacks,
      reducedMotion: () => reducedMotion.current,
      describeNode: (d) => describeNodeRef.current(d),
      entryNode: () => focusedIdRef.current ?? orderRef.current[0] ?? null,
    };
  });

  const restyle = () => rendererRef.current?.restyle();

  const computeBaseLabels = () => {
    const { labelMode: mode, ambient: amb } = liveRef.current;
    const nodes = shared.scene.nodes;
    const set = new Set<string>();
    if (!amb && mode !== "none") {
      if (mode === "all" || nodes.length <= 80) {
        nodes.forEach((n) => set.add(n.id));
      } else {
        [...nodes]
          .sort((a, b) => b.degree - a.degree)
          .slice(0, 25)
          .forEach((n) => set.add(n.id));
      }
    }
    baseLabelsRef.current = set;
  };

  /**
   * `fitOnSettle` refits the view once the simulation runs down, which is the
   * only moment the layout's true extent is known. It is one-shot and belongs
   * to the layout run that asked for it: a drag ending or a pin releasing also
   * runs the simulation out, and neither is a reason to move the camera.
   */
  const applyLayoutForces = (kick: number, fitOnSettle = false) => {
    const sim = simRef.current;
    if (!sim) return;
    const { nodes, links } = shared.scene;
    const {
      layout: current,
      layoutParams: params,
      scriptedTargets: scripted,
      preventOverlap: separate,
      ambient: amb,
      style: st,
    } = liveRef.current;
    const spacing = amb ? 1 : st.spacing;

    // A renderer-owned layout hands the physics over wholesale: cosmos runs
    // its simulation on the GPU and our simulation stands down until the
    // layout, or the renderer, changes back.
    const owner = rendererRef.current;
    if (!amb && owner?.runsSimulation?.(current)) {
      sim.stop();
      rendererOwnedSimRef.current = true;
      owner.startSimulation?.(kick, fitOnSettle);
      return;
    }
    owner?.stopSimulation?.();
    rendererOwnedSimRef.current = false;

    // Start from a clean slate so a layout never inherits the last one's forces.
    for (const name of ["charge", "link", "x", "y", "collide", "fa2"]) sim.force(name, null);

    // A pinned node keeps its spot through every layout change: fixing it is
    // exactly what fx/fy are for, and everything else lets go.
    const held = liveRef.current.pinned;
    const release = (n: GraphNode) => {
      if (held.has(n.id)) {
        n.fx = n.x ?? null;
        n.fy = n.y ?? null;
      } else {
        n.fx = null;
        n.fy = null;
      }
    };

    const targets = amb
      ? null
      : current === "script"
        ? (scripted ?? null)
        : computeTargets(current, params, graphRef.current);
    if (targets) {
      for (const n of nodes) {
        const t = targets.get(n.id);
        if (t) {
          n.tx = t.x * spacing;
          n.ty = t.y * spacing;
        }
        release(n);
      }
      sim
        .force("x", forceX<GraphNode>((d) => d.tx ?? 0).strength(0.3))
        .force("y", forceY<GraphNode>((d) => d.ty ?? 0).strength(0.3));
    } else {
      for (const n of nodes) release(n);
      if (!amb && current === "forceatlas2") {
        // ForceAtlas2 supplies its own repulsion, attraction and gravity, so
        // it replaces the charge and link forces rather than joining them.
        sim.force("fa2", forceAtlas2(links, forceAtlas2Params(params), layoutWeightColumn(params)));
      } else {
        sim
          .force(
            "link",
            forceLink<GraphNode, GraphLink>(links)
              .distance(
                (l) =>
                  (48 + (l.source as GraphNode).radius + (l.target as GraphNode).radius) * spacing,
              )
              .strength(amb ? 0.5 : 0.35),
          )
          .force(
            "charge",
            forceManyBody<GraphNode>()
              .strength((amb ? -120 : -260) * spacing * Math.sqrt(spacing))
              .distanceMax(700 * spacing),
          )
          .force("x", forceX<GraphNode>(0).strength(amb ? 0.045 : 0.03))
          .force("y", forceY<GraphNode>(0).strength(amb ? 0.045 : 0.03))
          .force(
            "collide",
            forceCollide<GraphNode>((d) => d.radius + 4),
          );
      }
    }

    if (!amb && separate && !sim.force("collide")) {
      sim.force("collide", forceCollide<GraphNode>((d) => d.radius + 4).strength(0.9));
    }

    /*
     * Asked for less movement, the layout is run out here instead of over the
     * next few seconds of frames, so it arrives already arranged. The result is
     * the same layout either way: what is skipped is watching it happen, which
     * is the part that is decoration rather than answer.
     *
     * Only up to a size, though. Past a few thousand nodes the settle takes
     * longer than the animation would have, and a page that stops responding is
     * not an improvement on a page that moves.
     */
    if (reducedMotion.current && !amb && nodes.length <= SETTLE_LIMIT) {
      sim.alpha(kick).stop();
      sim.tick(SETTLE_TICKS);
      drawRef.current();
      if (fitOnSettle) fitRef.current(0);
      notifyRunning(false);
      return;
    }
    sim.alpha(kick).restart();
    notifyRunning(true);
    if (fitOnSettle) {
      sim.on("end.fit", () => {
        sim.on("end.fit", null);
        fitRef.current(500);
      });
    }
  };

  /** The user has taken the camera; a fit still waiting on the layout lets go. */
  const disarmSettleFit = () => {
    simRef.current?.on("end.fit", null);
  };

  /** Bring a node into view, but only when it is not already in it. */
  const revealNode = (d: GraphNode): void => {
    const container = containerRef.current;
    const r = rendererRef.current;
    if (!container || !r) return;
    const at = r.screenPoint(d.x ?? 0, d.y ?? 0);
    if (!at) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const pad = 70;
    if (at.x >= pad && at.x <= w - pad && at.y >= pad && at.y <= h - pad) return;
    const k = r.transform()?.k ?? 1;
    r.centerOn(d.x ?? 0, d.y ?? 0, k, reducedMotion.current ? 0 : 220);
  };

  /**
   * Move focus to a node: the renderer's focus, the tooltip, the announcement
   * and the view all follow from here, so nothing can drift out of step with
   * what is actually focused.
   */
  const focusNode = (id: string | null, options: { move?: boolean } = {}): void => {
    const r = rendererRef.current;
    if (!r) return;
    focusedIdRef.current = id;
    r.focusNode(id, options);
    if (id === null) {
      hoverNodeRef.current = null;
      hideTooltip();
      restyle();
      return;
    }
    const datum = shared.scene.nodes.find((n) => n.id === id);
    if (!datum) return;
    hoverNodeRef.current = id;
    restyle();
    revealNode(datum);
    const anchor = r.nodeAnchor(id);
    if (anchor instanceof Element) showTooltipOn(anchor, nodeTooltip(datum));
    else if (anchor) showTooltipAt(anchor.x, anchor.y + 4, nodeTooltip(datum));
    announce(describeNode(datum));
  };
  const focusNodeRef = useRef(focusNode);
  focusNodeRef.current = focusNode;

  /** Step along one of the two orderings, wrapping at either end. */
  const step = (list: string[], from: string | null, delta: number): string | null => {
    if (list.length === 0) return null;
    const at = from === null ? -1 : list.indexOf(from);
    if (at === -1) return list[delta > 0 ? 0 : list.length - 1];
    return list[(at + delta + list.length) % list.length];
  };

  const onNodeKeyDown = (event: KeyboardEvent, d: GraphNode): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const order = orderRef.current;
    const neighbors = neighborListRef.current.get(d.id) ?? [];
    let next: string | null | undefined;

    switch (event.key) {
      case "ArrowRight":
        next = step(order, d.id, 1);
        break;
      case "ArrowLeft":
        next = step(order, d.id, -1);
        break;
      case "ArrowDown":
        next = step(neighbors, null, 1);
        break;
      case "ArrowUp":
        next = step(neighbors, null, -1);
        break;
      case "Home":
        next = order[0];
        break;
      case "End":
        next = order[order.length - 1];
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        event.stopPropagation();
        liveRef.current.onSelect({ kind: "node", id: d.id });
        announce(`${d.id} selected`);
        return;
      case "Escape":
        event.stopPropagation();
        hideTooltip();
        announce("");
        liveRef.current.onSelect(null);
        return;
      default:
        return;
    }

    // Arrows and Home/End are ours: the page would otherwise scroll under the
    // graph, and the app's own single-key shortcuts are not meant for someone
    // who is in the middle of reading a network.
    event.preventDefault();
    event.stopPropagation();
    if (next !== undefined && next !== null) focusNode(next);
    else if (neighbors.length === 0) announce(`${d.id} has no neighbours`);
  };
  const onNodeKeyDownRef = useRef(onNodeKeyDown);
  onNodeKeyDownRef.current = onNodeKeyDown;

  /**
   * Ease the view onto the whole graph. The easing is the point: a view that
   * jumps loses the reader's place, where one that travels keeps it. Asked for
   * less movement, it jumps anyway, because keeping someone's place is not
   * worth making them unwell.
   */
  const fit = (duration = 600) => {
    const r = rendererRef.current;
    const nodes = shared.scene.nodes;
    if (!r || nodes.length === 0) return;
    if (reducedMotion.current) duration = 0;
    r.fit(contentBounds(nodes, 60), duration);
  };

  // Installed once, alongside handlers that outlive their render, and so
  // reached the same way the repaint is: through a ref.
  const fitRef = useRef(fit);
  fitRef.current = fit;

  /** Place the tooltip near a point in the container's own coordinates. */
  const showTooltipAt = (px: number, py: number, html: string) => {
    const tip = tooltipRef.current;
    const container = containerRef.current;
    if (!tip || !container) return;
    tip.innerHTML = html;
    tip.style.display = "block";
    const rect = container.getBoundingClientRect();
    let x = px + 16;
    let y = py + 12;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    if (x + tw > rect.width - 8) x = px - tw - 12;
    if (y + th > rect.height - 8) y = py - th - 10;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };

  const showTooltip = (event: MouseEvent, html: string) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    showTooltipAt(event.clientX - rect.left, event.clientY - rect.top, html);
  };
  const showTooltipRef = useRef(showTooltip);
  showTooltipRef.current = showTooltip;

  /**
   * The same tooltip, anchored to a mark rather than to a pointer. Keyboard
   * focus has no coordinates of its own, and a tooltip that only ever appears
   * under a mouse is one half of the readers cannot get to (WCAG 1.4.13).
   */
  const showTooltipOn = (element: Element | null | undefined, html: string) => {
    const container = containerRef.current;
    if (!container || !element) return;
    const rect = container.getBoundingClientRect();
    const at = element.getBoundingClientRect();
    showTooltipAt(at.left - rect.left + at.width / 2, at.bottom - rect.top, html);
  };

  const hideTooltip = () => {
    const tip = tooltipRef.current;
    if (tip) tip.style.display = "none";
  };
  const hideTooltipRef = useRef(hideTooltip);
  hideTooltipRef.current = hideTooltip;

  const nodeTooltip = (d: GraphNode): string => {
    const idLine = d.label !== d.id ? `<div class="tip-sub">${escapeHtml(d.id)}</div>` : "";
    const group = d.group ? `<div class="tip-sub">${escapeHtml(d.group)}</div>` : "";
    const value =
      graph.ranking && d.value !== null
        ? `<div class="tip-sub">${escapeHtml(formatMetric(d.value))}</div>`
        : "";
    // The mark is too small to read a picture in, so the tooltip carries one
    // at a size that can be. The source was vetted on the way in, and a remote
    // one waits on the same permission the mark itself waits on.
    const { brokenImages: broken, allowRemoteImages: allowed } = liveRef.current;
    const remoteAndUnasked = d.image !== null && !allowed && isRemoteSource(d.image);
    const source = d.image !== null && !broken.has(d.image) && !remoteAndUnasked ? d.image : null;
    const image =
      source === null
        ? ""
        : `<img class="tip-image" referrerpolicy="no-referrer" src="${escapeHtml(source)}" />`;
    // The chosen node columns, the way the edge tooltip carries its own.
    const lines = liveRef.current
      .nodeAttrsFor(d)
      .filter((c) => d.row[c.name] !== null && d.row[c.name] !== "" && d.row[c.name] !== undefined)
      .map(
        (c) =>
          `<div class="tip-row"><span>${escapeHtml(c.name)}</span>${escapeHtml(
            displayCell(c, d.row[c.name]),
          )}</div>`,
      )
      .join("");
    return (
      `<div class="tip-title">${escapeHtml(d.label)}</div>${idLine}${group}${value}${image}` +
      `${lines}<div class="tip-meta">${d.inDegree} in · ${d.outDegree} out</div>`
    );
  };
  const nodeTooltipRef = useRef(nodeTooltip);
  nodeTooltipRef.current = nodeTooltip;

  const linkTooltip = (l: GraphLink): string => {
    const attrs = liveRef.current.edgeAttrsFor(l);
    const name = (e: string | GraphNode) => (typeof e === "string" ? e : e.label);
    const head = `<div class="tip-title">${escapeHtml(name(l.source))} → ${escapeHtml(name(l.target))}</div>`;
    const row = l.rows[0] as Row | undefined;
    const lines = row
      ? attrs
          .filter((c) => row[c] !== null && row[c] !== "")
          .map(
            (c) => `<div class="tip-row"><span>${escapeHtml(c)}</span>${escapeHtml(row[c])}</div>`,
          )
          .join("")
      : "";
    const more =
      l.rows.length > 1 ? `<div class="tip-meta">+${l.rows.length - 1} more rows</div>` : "";
    return head + lines + more;
  };
  const linkTooltipRef = useRef(linkTooltip);
  linkTooltipRef.current = linkTooltip;

  /**
   * Build the scene. Only the network itself brings us back here: new nodes,
   * new links, or the same ones filtered differently. Everything about how they
   * look is the effect below, which does not throw the simulation away.
   */
  useLayoutEffect(() => {
    const previous = new Map(shared.scene.nodes.map((n) => [n.id, n]));
    // A node the user just placed starts where they dropped it rather than on
    // the seeding spiral, so it does not appear to jump away from the cursor;
    // an imported layout arrives the same way.
    const seeds = seedPositions?.current ?? null;
    if (seedPositions) seedPositions.current = null;
    const nodes: GraphNode[] = graph.nodes.map((n, i) => {
      const old = previous.get(n.id);
      // Golden-angle spiral seeding: deterministic and roughly circular.
      const angle = i * 2.39996;
      const r = 24 * Math.sqrt(i + 1);
      // A seeded position wins outright; otherwise keep where the node already
      // was, and fall back to a golden-angle spiral for anything brand new.
      const seed = seeds?.get(n.id);
      const spiral = { x: r * Math.cos(angle), y: r * Math.sin(angle) };
      return {
        ...n,
        x: seed?.x ?? old?.x ?? spiral.x,
        y: seed?.y ?? old?.y ?? spiral.y,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: GraphLink[] = graph.links.map((l) => ({
      ...l,
      source: byId.get(endpoint(l.source)) as GraphNode,
      target: byId.get(endpoint(l.target)) as GraphNode,
    }));
    shared.scene.nodes = nodes;
    shared.scene.links = links;
    hoverLinkRef.current = null;

    const adjacency = new Map<string, Set<string>>();
    for (const n of nodes) adjacency.set(n.id, new Set([n.id]));
    for (const l of links) {
      const s = endpoint(l.source);
      const t = endpoint(l.target);
      adjacency.get(s)?.add(t);
      adjacency.get(t)?.add(s);
    }
    adjacencyRef.current = adjacency;
    hoverNodeRef.current = null;

    // The two keyboard orderings. Most connected first in both, because that is
    // the order someone reading a network wants to meet it in, and because it
    // makes the tour deterministic rather than dependent on row order.
    const byDegree = (a: string, b: string) =>
      (byId.get(b)?.degree ?? 0) - (byId.get(a)?.degree ?? 0) || a.localeCompare(b);
    orderRef.current = nodes.map((n) => n.id).sort(byDegree);
    const neighborList = new Map<string, string[]>();
    for (const [id, set] of adjacency) {
      neighborList.set(id, [...set].filter((other) => other !== id).sort(byDegree));
    }
    neighborListRef.current = neighborList;
    // Whoever was focused may not be here any more.
    if (focusedIdRef.current !== null && !byId.has(focusedIdRef.current)) {
      focusedIdRef.current = null;
    }

    computeBaseLabels();
    rendererRef.current?.build();

    const draw = () => rendererRef.current?.draw();
    drawRef.current = draw;

    const sim = forceSimulation<GraphNode, GraphLink>(nodes)
      .velocityDecay(ambient ? 0.35 : 0.45)
      .on("tick", draw)
      .on("end.activity", () => notifyRunning(false));
    // The empty state's background drifts forever, which is exactly the kind of
    // motion the setting is about, so it settles and stops instead.
    if (ambient && !reducedMotion.current) sim.alphaDecay(0.002).alphaMin(0);
    simRef.current?.stop();
    simRef.current = sim;

    // Seeds covering most of the graph are a layout already run somewhere
    // else: a GEXF with positions, a shared workspace. The forces are hooked
    // up but given no heat at all, because any heat lets the links pull an
    // arrangement that is not their equilibrium toward it; the simulation
    // ends on its first step, which is also what fires the settle fit. The
    // Layout button is still there for whoever wants it re-run.
    const seededCount = seeds === null ? 0 : nodes.filter((n) => seeds.has(n.id)).length;
    const seeded =
      (seededCount > 0 && seededCount * 2 >= nodes.length) || seededBaseRef.current === base;
    seededBaseRef.current = seeded ? base : null;
    justBuiltRef.current = true;
    applyLayoutForces(seeded ? 0 : 1, true);
    restyle();

    // Early feedback while the layout is still spreading; the settle fit
    // armed above re-frames whatever it ends as.
    const timer = window.setTimeout(() => fit(650), 700);
    return () => {
      window.clearTimeout(timer);
      sim.stop();
    };
    // Keyed on the structure alone. `graph` is read here for the appearance the
    // first paint needs, but a change to it on its own is the next effect's.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  /**
   * Appearance, written onto the nodes the simulation is already running.
   *
   * `applyStyle` hands back new objects, but the simulation owns the ones on
   * screen, along with their positions and velocities. So the new values are
   * copied across rather than swapped in, and the marks repaint from the same
   * objects the renderer is already bound to.
   *
   * Radius is the one that is not only drawn. The collide radius and the link
   * distance are both read off it, and d3 caches those when a force is
   * initialized, so a resize has to rebuild the forces and nudge the simulation
   * to settle into the room the new sizes need. A recolour does not, and that
   * is the whole difference between this and a rebuild.
   */
  useLayoutEffect(() => {
    let resized = false;
    const incoming = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const live of shared.scene.nodes) {
      const next = incoming.get(live.id);
      if (!next) continue;
      if (live.radius !== next.radius) resized = true;
      live.label = next.label;
      live.group = next.group;
      live.value = next.value;
      live.color = next.color;
      live.image = next.image;
      live.radius = next.radius;
    }

    const incomingLinks = new Map(graph.links.map((l) => [linkKeyOf(l), l]));
    for (const live of shared.scene.links) {
      const next = incomingLinks.get(linkKeyOf(live));
      if (!next) continue;
      live.weight = next.weight;
      live.colorValue = next.colorValue;
      live.color = next.color;
      live.width = next.width;
    }

    computeBaseLabels();
    rendererRef.current?.graphChanged?.();
    restyle();
    drawRef.current();
    if (resized) applyLayoutForces(0.3);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Layout and spacing switches morph the existing scene. A rebuild in the
  // same commit already applied them, which covers the mount as well.
  useEffect(() => {
    if (justBuiltRef.current) return;
    applyLayoutForces(0.9, true);
    // Physics layouts are still spreading at 700ms, so fit once early for
    // feedback; the settle fit re-frames the layout once it actually ends.
    const early = window.setTimeout(() => fit(650), 700);
    return () => {
      window.clearTimeout(early);
    };
    // Scripted targets are part of the layout: re-running a script while the
    // "script" layout is already chosen changes them and nothing else.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layoutParams, preventOverlap, style.spacing, scriptedTargets]);

  useEffect(() => {
    computeBaseLabels();
    restyle();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [labelMode, selection, style.arrows, theme, highlightPath, dimmed]);

  // Pinning holds the node where it stands; unpinning hands it back to the
  // layout, which is the same act as switching layouts, so the same code runs
  // it, with just enough heat for the released node to drift home. A document
  // load replaces the set wholesale, and the rebuild has already honoured it.
  useEffect(() => {
    if (justBuiltRef.current) return;
    applyLayoutForces(0.08);
    restyle();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);

  // A changed pattern set repaints; the SVG renderer swaps its own defs from
  // the prop in the same commit.
  useEffect(() => {
    restyle();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePatterns]);

  /**
   * A renderer swap repaints the same scene through the new painter: same
   * nodes, same simulation, same camera. Nothing reheats, which is what makes
   * the swap cheap enough to offer as a setting.
   */
  useLayoutEffect(() => {
    if (justBuiltRef.current) return;
    const r = rendererRef.current;
    if (!r) return;
    r.build();
    // A camera-less renderer (WebGL owns its own) refits instead of restoring.
    if (cameraRef.current && r.transform() !== null) r.setTransform(cameraRef.current);
    else fitRef.current(0);
    r.focusNode(focusedIdRef.current, { move: false });
    r.restyle();
    r.draw();
    // Only when the physics changes hands: a renderer-owned layout was
    // falling back to plain force under the old renderer, or the old renderer
    // was the one simulating. A plain SVG-to-canvas swap reheats nothing.
    const shouldOwn = r.runsSimulation?.(liveRef.current.layout) === true;
    if (shouldOwn || rendererOwnedSimRef.current) applyLayoutForces(0.3, shouldOwn);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRenderer]);

  // Declared after every effect that consults it, so it runs last in each
  // commit and the rebuild's stand-down lasts exactly that one commit.
  useEffect(() => {
    justBuiltRef.current = false;
  });

  useImperativeHandle(ref, () => ({
    fit: () => fit(600),
    reheat: () => {
      applyLayoutForces(0.9, true);
    },
    separate: () => {
      noverlap(shared.scene.nodes);
      simRef.current?.alpha(0.05).restart();
      window.setTimeout(() => fit(500), 60);
    },
    tidyLabels: () => {
      // Only the labels actually on screen push anything around: the base
      // set, plus whatever hover or selection has forced visible is
      // transient and not worth re-arranging the graph for.
      const visible = new Map<string, string>();
      for (const node of shared.scene.nodes) {
        if (baseLabelsRef.current.has(node.id)) visible.set(node.id, node.label);
      }
      labelNoverlap(shared.scene.nodes, visible, liveRef.current.pinned);
      simRef.current?.alpha(0.05).restart();
      window.setTimeout(() => fit(500), 60);
    },
    center: (id: string) => {
      const r = rendererRef.current;
      const node = shared.scene.nodes.find((n) => n.id === id);
      if (!r || !node) return;
      // Zoomed out the label would arrive unreadable, so the travel also
      // brings the scale up to one; zoomed in it stays where the reader put it.
      const k = Math.max(r.transform()?.k ?? 1, 1);
      r.centerOn(node.x ?? 0, node.y ?? 0, k, reducedMotion.current ? 0 : 450);
    },
    buildExport: () => {
      const r = rendererRef.current;
      const nodes = shared.scene.nodes;
      if (!r?.exportSvg || nodes.length === 0) return null;
      const box = contentBounds(nodes, 70);
      return { svgText: r.exportSvg(box, liveRef.current.theme.surface), box };
    },
    pauseLayout: () => {
      const r = rendererRef.current;
      if (rendererOwnedSimRef.current && r?.pauseSimulation) {
        r.pauseSimulation();
        return;
      }
      simRef.current?.stop();
      notifyRunning(false);
    },
    resumeLayout: () => {
      const r = rendererRef.current;
      if (rendererOwnedSimRef.current && r?.resumeSimulation) {
        r.resumeSimulation();
        return;
      }
      // Picks up at whatever alpha the pause froze; an already-cold run just
      // ends again, which reads as nothing happening because nothing should.
      simRef.current?.restart();
      notifyRunning(true);
    },
    exportPng: async () => {
      const { nodes, links } = shared.scene;
      if (nodes.length === 0) return null;
      // A GPU simulation may hold fresher positions than the nodes do.
      rendererRef.current?.syncPositions?.();
      const box = contentBounds(nodes, 70);
      // The scene is repainted at export scale rather than screenshotted, so
      // the file is crisp whatever the window looked like; the scale gives
      // way when the layout's extent would ask for an absurd surface.
      const scale = Math.min(2, PNG_MAX_PIXELS / Math.max(box.width, box.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(box.width * scale));
      canvas.height = Math.max(1, Math.round(box.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
      ctx.fillStyle = liveRef.current.theme.surface;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
      const view: ViewState = {
        ...shared.view(),
        // Transient pointer and keyboard state has no place in a file.
        hoverLink: null,
        keyboardFocusId: null,
      };
      paintScene(ctx, nodes, links, view, { exportSafe: true });
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))),
          "image/png",
        );
      });
    },
  }));

  // Ids for the bits the svg points at. Two canvases are never mounted at once
  // (the ambient one stands in for the real one), so a fixed id is safe, and a
  // shadow root scopes them anyway.
  const helpId = "graph-keys-help";
  return (
    <div className={ambient ? "graph-canvas ambient" : "graph-canvas"} ref={containerRef}>
      {activeRenderer === "svg" && (
        <SvgScene
          ref={rendererRef}
          shared={shared}
          ambient={ambient}
          theme={theme}
          arrowColors={arrowColors}
          imagePatterns={imagePatterns}
        />
      )}
      {activeRenderer === "canvas" && <CanvasScene ref={rendererRef} shared={shared} />}
      {activeRenderer === "webgl" && (
        <WebglScene ref={rendererRef} shared={shared} onFailed={() => onRendererFailed?.()} />
      )}
      {!ambient && <div className="graph-tooltip" ref={tooltipRef} />}
      {!ambient && (
        <>
          <p id={helpId} className="visually-hidden">
            Left and right arrows move through every node, most connected first. Up and down move
            between the neighbours of the current node. Enter selects it, Escape clears the
            selection.
          </p>
          {/* Written to directly rather than rendered from state: focus moves on
              every arrow press, and re-rendering the whole canvas to say so
              would be a great deal of work to announce one name. React is given
              no children here, so nothing it owns is being overwritten. */}
          <div ref={liveRegionRef} className="visually-hidden" role="status" aria-live="polite" />
        </>
      )}
    </div>
  );
}
