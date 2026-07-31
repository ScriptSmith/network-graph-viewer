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
import { select, type Selection } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3-zoom";
import { drag } from "d3-drag";
import "d3-transition";
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
  layoutWeightColumn,
  noverlap,
  type LayoutId,
  type LayoutParams,
} from "../lib/layouts";
import { endpointId as endpoint, markColor, weightScale } from "../lib/graph";
import { edgeKey } from "../lib/cells";
import { isRemoteSource } from "../lib/images";
import { buildSvgDocument, contentBounds, type ExportBox } from "../lib/export";
import { displayCell, formatMetric } from "../lib/format";
import { DEFAULT_COLORS, type GraphTheme, type Palette } from "../theme";

export interface GraphCanvasHandle {
  fit: () => void;
  reheat: () => void;
  /** Nudge overlapping nodes apart in place, leaving the layout otherwise alone. */
  separate: () => void;
  /** Travel to one node and put it in the middle at a readable scale. */
  center: (id: string) => void;
  buildExport: () => { svgText: string; box: ExportBox } | null;
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
  /** Edit mode: adds the create, connect and delete affordances. */
  editing?: boolean;
  /**
   * Positions to seed the next scene with, consumed once. Used when a node is
   * dropped on the canvas and when a file arrives carrying a layout.
   */
  seedPositions?: RefObject<Map<string, { x: number; y: number }> | null>;
  onAddNode?: (x: number, y: number) => void;
  onConnect?: (source: string, target: string) => void;
  onDeleteNode?: (id: string) => void;
  onRenameNode?: (id: string) => void;
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

type NodeSel = Selection<SVGCircleElement, GraphNode, SVGGElement, unknown>;
type LinkSel = Selection<SVGPathElement, GraphLink, SVGGElement, unknown>;
type LabelSel = Selection<SVGTextElement, GraphNode, SVGGElement, unknown>;

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Identity of a link across rebuilds and restyles: the pair of endpoints it
 * joins. Through `edgeKey`, so an id holding whatever a spreadsheet held cannot
 * collide with the pair beside it, and so the separator is spelled in exactly
 * one place.
 */
const linkKeyOf = (l: GraphLink) => edgeKey(endpoint(l.source), endpoint(l.target));

/**
 * How big a graph will still be settled in one go for a reader who asked for
 * less movement, and how many steps that takes. The tick count is roughly where
 * d3's default decay has the simulation cool anyway.
 */
const SETTLE_LIMIT = 2000;
const SETTLE_TICKS = 200;

const EMPTY_PINNED: ReadonlySet<string> = new Set();
const NO_EDGE_ATTRS = (): string[] => [];
const NO_NODE_ATTRS = (): Column[] => [];

/** Marker id matching an edge stroke color; markers are pre-defined per color. */
function markerFor(stroke: string, arrowColors: string[], theme: GraphTheme): string {
  if (stroke === theme.edgeLit) return "url(#arrow-lit)";
  if (stroke === theme.neutral) return "url(#arrow-cn)";
  const slot = arrowColors.indexOf(stroke);
  return slot === -1 ? "url(#arrow-dim)" : `url(#arrow-c${slot})`;
}

export function GraphCanvas({
  graph,
  base,
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
  seedPositions,
  allowRemoteImages = false,
  pinned = EMPTY_PINNED,
  onPinNode,
  ambient = false,
  reducedMotion: reducedMotionProp = false,
  ref,
}: GraphCanvasProps) {
  const selectedId = selection?.kind === "node" ? selection.id : null;
  const selectedEdge = selection?.kind === "edge" ? selection : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const selsRef = useRef<{ node: NodeSel; link: LinkSel; hit: LinkSel; label: LabelSel } | null>(
    null,
  );
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
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
  /** Paint the marks at the positions the simulation currently holds. */
  const drawRef = useRef<() => void>(() => {});

  const edgeWidth = useMemo(
    () => weightScale(graph.links, isCellStyle(style.edgeWidth)),
    [graph, style.edgeWidth],
  );
  // A typed edge can carry a width of its own, which skips the scale.
  const strokeWidth = (d: GraphLink): number => d.width ?? edgeWidth(d);

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
    arrowColors,
    edgeAttrsFor,
    nodeAttrsFor,
    ambient,
    style,
    brokenImages,
    allowRemoteImages,
    pinned,
    onPinNode,
    theme,
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
    arrowColors,
    edgeAttrsFor,
    nodeAttrsFor,
    ambient,
    style,
    brokenImages,
    allowRemoteImages,
    pinned,
    onPinNode,
    theme,
  };

  /** What color the node stands for, image or no image. */
  const nodeTint = (d: GraphNode): string =>
    markColor(d, graph.ranking, liveRef.current.colors, liveRef.current.palette);

  const imageFill = (d: GraphNode): string | null => {
    const id = d.image === null ? undefined : imagePatterns.get(d.image);
    return id === undefined ? null : `url(#${id})`;
  };

  // A pictured node keeps its colour as a ring, so an image never costs the
  // reader whatever the colours were encoding.
  const nodeFill = (d: GraphNode): string => imageFill(d) ?? nodeTint(d);
  const nodeStroke = (d: GraphNode): string => {
    if (d.id === liveRef.current.selectedId) return liveRef.current.theme.selectRing;
    return imageFill(d) === null ? liveRef.current.theme.surface : nodeTint(d);
  };
  const nodeStrokeWidth = (d: GraphNode): number => {
    if (d.id === liveRef.current.selectedId) return 2.5;
    return imageFill(d) === null ? 1.5 : 2;
  };

  const edgeBase = (d: GraphLink): string => {
    if (d.color !== null) return d.color;
    if (d.colorValue === null) return liveRef.current.theme.edge;
    return liveRef.current.edgeColors.get(d.colorValue) ?? liveRef.current.theme.neutral;
  };

  const linkPath = (l: GraphLink): string => {
    const s = l.source as GraphNode;
    const t = l.target as GraphNode;
    const sx = s.x ?? 0;
    const sy = s.y ?? 0;
    const tx = t.x ?? 0;
    const ty = t.y ?? 0;
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const x1 = sx + ux * s.radius;
    const y1 = sy + uy * s.radius;
    const x2 = tx - ux * (t.radius + 3);
    const y2 = ty - uy * (t.radius + 3);
    if (!l.curve) return `M${x1},${y1}L${x2},${y2}`;
    const mx = (x1 + x2) / 2 - uy * dist * 0.14;
    const my = (y1 + y2) / 2 + ux * dist * 0.14;
    return `M${x1},${y1}Q${mx},${my} ${x2},${y2}`;
  };

  const refreshStyles = () => {
    const sels = selsRef.current;
    if (!sels) return;
    const { selectedId: sel, selectedEdge: edge, style: st } = liveRef.current;
    const focus = hoverNodeRef.current ?? sel;
    const neighbors = focus ? adjacencyRef.current.get(focus) : null;
    const base = baseLabelsRef.current;
    const picked = (d: GraphLink) =>
      edge !== null && endpoint(d.source) === edge.source && endpoint(d.target) === edge.target;

    sels.node
      .attr("opacity", (d) => (neighbors && !neighbors.has(d.id) ? 0.14 : 1))
      .attr("stroke", nodeStroke)
      .attr("stroke-width", nodeStrokeWidth)
      // The pin is worn as a dashed ring: an attribute on the same circle, so
      // it survives export and the node stays one mark to hit and drag.
      .attr("stroke-dasharray", (d) => (liveRef.current.pinned.has(d.id) ? "3 3" : null));

    // A selected edge is lit the way a hovered one is, and keeps that whatever
    // the neighbourhood dimming would otherwise have said about it.
    sels.link
      .attr("stroke", (d) => {
        const lit =
          picked(d) ||
          (neighbors && (endpoint(d.source) === focus || endpoint(d.target) === focus));
        return lit ? liveRef.current.theme.edgeLit : edgeBase(d);
      })
      .attr("stroke-width", (d) => strokeWidth(d) * (picked(d) ? 2.2 : 1))
      .attr("opacity", (d) => {
        if (picked(d)) return 1;
        if (!neighbors) return d.colorValue === null ? 0.85 : 0.9;
        const touches = endpoint(d.source) === focus || endpoint(d.target) === focus;
        return touches ? 0.95 : 0.06;
      })
      .attr("marker-end", (d) => {
        if (!st.arrows) return null;
        const lit =
          picked(d) ||
          (neighbors && (endpoint(d.source) === focus || endpoint(d.target) === focus));
        return markerFor(
          lit ? liveRef.current.theme.edgeLit : edgeBase(d),
          liveRef.current.arrowColors,
          liveRef.current.theme,
        );
      });

    // Colours as well as visibility: a theme change repaints through here,
    // and the labels were given their fill once, when the scene was built.
    sels.label
      .attr("fill", liveRef.current.theme.label)
      .attr("stroke", liveRef.current.theme.labelHalo);

    sels.label.attr("display", (d) => {
      if (neighbors) return neighbors.has(d.id) ? null : "none";
      // Selecting an edge names both of its ends, whatever the label mode.
      if (edge && (d.id === edge.source || d.id === edge.target)) return null;
      return base.has(d.id) || d.id === sel ? null : "none";
    });
  };

  // Installed handlers outlive the render that created them, and after the
  // split the scene is not rebuilt on every restyle, so reaching for the
  // current one through a ref is what keeps a hover repaint up to date.
  const refreshStylesRef = useRef(refreshStyles);
  refreshStylesRef.current = refreshStyles;

  const computeBaseLabels = () => {
    const { labelMode: mode, ambient: amb } = liveRef.current;
    const nodes = nodesRef.current;
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
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const {
      layout: current,
      layoutParams: params,
      scriptedTargets: scripted,
      preventOverlap: separate,
      ambient: amb,
      style: st,
    } = liveRef.current;
    const spacing = amb ? 1 : st.spacing;

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
        : computeTargets(current, params, graph);
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
      return;
    }
    sim.alpha(kick).restart();
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

  /* ---- Reaching the graph from the keyboard ---- */

  /**
   * A graph is not a list, and tabbing through one node at a time would be a
   * poor way to read even a small one. So there are two movements, and no mode
   * to be in: left and right walk every node in turn, most connected first,
   * which is a tour of the graph; up and down walk the neighbours of wherever
   * you are, which is the structure itself. Enter selects, Escape lets go.
   *
   * Focus is a real DOM focus on a real circle, so the browser's own focus ring
   * and a screen reader's own reporting both work. Only one node carries a
   * tabindex at a time, or a graph of any size would fill the tab order.
   */
  const orderRef = useRef<string[]>([]);
  const neighborListRef = useRef<Map<string, string[]>>(new Map());
  const focusedIdRef = useRef<string | null>(null);
  const liveRegionRef = useRef<HTMLDivElement>(null);
  // As a ref, the way the other live values are: d3 handlers installed once
  // read it when they run, and a re-render in between is neither needed nor
  // wanted.
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

  /** Bring a node into view, but only when it is not already in it. */
  const revealNode = (d: GraphNode): void => {
    const svg = svgRef.current;
    const container = containerRef.current;
    const behavior = zoomRef.current;
    if (!svg || !container || !behavior) return;
    const transform = zoomTransform(svg);
    const [sx, sy] = transform.apply([d.x ?? 0, d.y ?? 0]);
    const w = container.clientWidth;
    const h = container.clientHeight;
    const pad = 70;
    if (sx >= pad && sx <= w - pad && sy >= pad && sy <= h - pad) return;
    const k = transform.k;
    const next = zoomIdentity.translate(w / 2 - k * (d.x ?? 0), h / 2 - k * (d.y ?? 0)).scale(k);
    const sel = select(svg);
    if (reducedMotion.current) sel.call(behavior.transform, next);
    else sel.transition().duration(220).call(behavior.transform, next);
  };

  /**
   * Move focus to a node: the tabindex, the browser focus, the tooltip, the
   * announcement and the view all follow from here, so nothing can drift out of
   * step with what is actually focused.
   */
  const focusNode = (id: string | null, options: { move?: boolean } = {}): void => {
    const sels = selsRef.current;
    if (!sels) return;
    focusedIdRef.current = id;
    sels.node.attr("tabindex", (d) => (d.id === id ? 0 : null));
    if (id === null) {
      hoverNodeRef.current = null;
      hideTooltip();
      refreshStyles();
      return;
    }
    const datum = nodesRef.current.find((n) => n.id === id);
    if (!datum) return;
    const element = sels.node.filter((d) => d.id === id).node();
    if (options.move !== false) element?.focus({ preventScroll: true });
    hoverNodeRef.current = id;
    refreshStyles();
    revealNode(datum);
    showTooltipOn(element, nodeTooltip(datum));
    announce(describeNode(datum));
  };

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

  /**
   * Ease the view onto the whole graph. The easing is the point: a view that
   * jumps loses the reader's place, where one that travels keeps it. Asked for
   * less movement, it jumps anyway, because keeping someone's place is not
   * worth making them unwell.
   */
  const fit = (duration = 600) => {
    const container = containerRef.current;
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!container || !svg || !behavior || nodesRef.current.length === 0) return;
    if (reducedMotion.current) duration = 0;
    const box = contentBounds(nodesRef.current, 60);
    const w = container.clientWidth;
    const h = container.clientHeight;
    const k = Math.max(0.05, Math.min(w / box.width, h / box.height, 1.5));
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const t = zoomIdentity
      .translate(w / 2, h / 2)
      .scale(k)
      .translate(-cx, -cy);
    const sel = select(svg);
    if (duration > 0) {
      sel.transition().duration(duration).call(behavior.transform, t);
    } else {
      sel.call(behavior.transform, t);
    }
  };

  // Installed once, with the zoom behaviour, and so reached the same way the
  // repaint is: through a ref, rather than through whichever render was current
  // when the double-click handler was attached.
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

  /**
   * Build the scene. Only the network itself brings us back here: new nodes,
   * new links, or the same ones filtered differently. Everything about how they
   * look is the effect below, which does not throw the simulation away.
   */
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (!svg || !viewport) return;

    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
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
    nodesRef.current = nodes;
    linksRef.current = links;

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

    const { ambient: amb, style: st } = liveRef.current;
    const root = select(viewport);
    const linkLayer = root.select<SVGGElement>("[data-links]");
    const hitLayer = root.select<SVGGElement>("[data-hits]");
    const nodeLayer = root.select<SVGGElement>("[data-nodes]");
    const labelLayer = root.select<SVGGElement>("[data-labels]");

    const link = linkLayer
      .selectAll<SVGPathElement, GraphLink>("path")
      .data(links, linkKeyOf)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => edgeBase(d))
      .attr("stroke-width", (d) => strokeWidth(d))
      .attr("stroke-linecap", "round")
      .attr("marker-end", (d) =>
        amb || !st.arrows ? null : markerFor(edgeBase(d), arrowColors, theme),
      );

    const hit = hitLayer
      .selectAll<SVGPathElement, GraphLink>("path")
      .data(amb ? [] : links, linkKeyOf)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 11)
      .style("cursor", "pointer")
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        liveRef.current.onSelect({
          kind: "edge",
          source: endpoint(d.source),
          target: endpoint(d.target),
        });
      })
      .on("mouseenter", (event: MouseEvent, d) => {
        showTooltip(event, linkTooltip(d));
        link
          .filter((l) => l === d)
          .attr("stroke", liveRef.current.theme.edgeLit)
          .attr("opacity", 1)
          .attr("marker-end", liveRef.current.style.arrows ? "url(#arrow-lit)" : null);
      })
      .on("mousemove", (event: MouseEvent, d) => showTooltip(event, linkTooltip(d)))
      .on("mouseleave", () => {
        hideTooltip();
        refreshStylesRef.current();
      });

    const node = nodeLayer
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes, (d) => d.id)
      .join("circle")
      .attr("data-id", (d) => d.id)
      .attr("r", (d) => d.radius)
      .attr("fill", nodeFill)
      .attr("stroke", nodeStroke)
      .attr("stroke-width", nodeStrokeWidth)
      .style("cursor", amb ? "default" : "pointer");

    if (!amb) {
      // Exactly one node is in the tab order at a time. Reaching the graph puts
      // focus on the most connected node, which is the one worth arriving at.
      const entry = focusedIdRef.current ?? orderRef.current[0] ?? null;
      node
        .attr("role", "button")
        .attr("aria-label", (d) => describeNode(d))
        .attr("tabindex", (d) => (d.id === entry ? 0 : null));
    }

    const label = labelLayer
      .selectAll<SVGTextElement, GraphNode>("text")
      .data(amb ? [] : nodes, (d) => d.id)
      .join("text")
      .text((d) => d.label)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("font-weight", 500)
      .attr("fill", liveRef.current.theme.label)
      .attr("stroke", liveRef.current.theme.labelHalo)
      .attr("stroke-width", 3.5)
      .attr("paint-order", "stroke")
      .attr("pointer-events", "none");

    selsRef.current = { node, link, hit, label };

    if (!amb) {
      node
        .on("mouseenter", (event: MouseEvent, d) => {
          hoverNodeRef.current = d.id;
          refreshStylesRef.current();
          showTooltip(event, nodeTooltip(d));
        })
        .on("mousemove", (event: MouseEvent, d) => showTooltip(event, nodeTooltip(d)))
        .on("mouseleave", () => {
          hoverNodeRef.current = null;
          refreshStylesRef.current();
          hideTooltip();
        })
        .on("click", (event: MouseEvent, d) => {
          event.stopPropagation();
          liveRef.current.onSelect({ kind: "node", id: d.id });
        })
        // Focus does what hover does, so the graph reads the same whether it is
        // being pointed at or tabbed through.
        .on("focus", (_event: FocusEvent, d) => focusNode(d.id, { move: false }))
        .on("blur", () => {
          hoverNodeRef.current = null;
          hideTooltip();
          refreshStylesRef.current();
        })
        .on("keydown", (event: KeyboardEvent, d) => onNodeKeyDown(event, d));

      node.call(
        drag<SVGCircleElement, GraphNode>()
          .on("start", (_event, d) => {
            disarmSettleFit();
            simRef.current?.alphaTarget(0.25).restart();
            d.fx = d.x;
            d.fy = d.y;
            hideTooltip();
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            simRef.current?.alphaTarget(0);
            const shiftPin = event.sourceEvent instanceof MouseEvent && event.sourceEvent.shiftKey;
            if (liveRef.current.pinned.has(d.id) || shiftPin) {
              // Pinned, or being pinned: the dropped spot is the point.
              d.fx = event.x;
              d.fy = event.y;
              d.tx = event.x;
              d.ty = event.y;
              if (!liveRef.current.pinned.has(d.id)) liveRef.current.onPinNode?.(d.id);
            } else if (
              liveRef.current.layout === "force" ||
              liveRef.current.layout === "forceatlas2"
            ) {
              d.fx = null;
              d.fy = null;
            } else {
              // In static layouts a dragged node keeps its dropped spot.
              d.tx = event.x;
              d.ty = event.y;
              d.fx = null;
              d.fy = null;
            }
          }),
      );
    }

    // Named, because it is wanted twice: on every frame while the layout runs,
    // and once at the end when the layout was run out rather than watched.
    const draw = () => {
      link.attr("d", linkPath);
      hit.attr("d", linkPath);
      node.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
      // On ring-shaped layouts labels radiate outward from the origin so
      // they don't pile up at the top and bottom of the circle.
      const rings = liveRef.current.layout === "circle" || liveRef.current.layout === "radial";
      label
        .attr("text-anchor", (d) => {
          if (!rings) return "middle";
          const c = Math.cos(Math.atan2(d.y ?? 0, d.x ?? 0));
          return c > 0.2 ? "start" : c < -0.2 ? "end" : "middle";
        })
        .attr("x", (d) => {
          if (!rings) return d.x ?? 0;
          return (d.x ?? 0) + Math.cos(Math.atan2(d.y ?? 0, d.x ?? 0)) * (d.radius + 8);
        })
        .attr("y", (d) => {
          if (!rings) return (d.y ?? 0) - d.radius - 6;
          const s = Math.sin(Math.atan2(d.y ?? 0, d.x ?? 0));
          return (d.y ?? 0) + s * (d.radius + 8) + (s > 0.35 ? 10 : s < -0.35 ? -4 : 4);
        });
    };
    drawRef.current = draw;

    const sim = forceSimulation<GraphNode, GraphLink>(nodes)
      .velocityDecay(amb ? 0.35 : 0.45)
      .on("tick", draw);
    // The empty state's background drifts forever, which is exactly the kind of
    // motion the setting is about, so it settles and stops instead.
    if (amb && !reducedMotion.current) sim.alphaDecay(0.002).alphaMin(0);
    simRef.current?.stop();
    simRef.current = sim;

    computeBaseLabels();
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
    refreshStyles();

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
   * objects d3 is already bound to.
   *
   * Radius is the one that is not only drawn. The collide radius and the link
   * distance are both read off it, and d3 caches those when a force is
   * initialized, so a resize has to rebuild the forces and nudge the simulation
   * to settle into the room the new sizes need. A recolour does not, and that
   * is the whole difference between this and a rebuild.
   */
  useLayoutEffect(() => {
    const sels = selsRef.current;
    if (!sels) return;

    let resized = false;
    const incoming = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const live of nodesRef.current) {
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
    for (const live of linksRef.current) {
      const next = incomingLinks.get(linkKeyOf(live));
      if (!next) continue;
      live.weight = next.weight;
      live.colorValue = next.colorValue;
      live.color = next.color;
      live.width = next.width;
    }

    sels.node.attr("r", (d) => d.radius);
    sels.label.text((d) => d.label);
    if (!liveRef.current.ambient) sels.node.attr("aria-label", (d) => describeNode(d));
    computeBaseLabels();
    refreshStyles();
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
    refreshStyles();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [labelMode, selection, style.arrows, theme]);

  // Pinning holds the node where it stands; unpinning hands it back to the
  // layout, which is the same act as switching layouts, so the same code runs
  // it, with just enough heat for the released node to drift home. A document
  // load replaces the set wholesale, and the rebuild has already honoured it.
  useEffect(() => {
    if (justBuiltRef.current) return;
    applyLayoutForces(0.08);
    refreshStyles();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);

  // A pattern that has just been dropped from the defs must stop being named
  // before anything paints, or the node it filled would come out blank. Fills
  // are otherwise set once, when the scene is built.
  useLayoutEffect(() => {
    selsRef.current?.node
      .attr("fill", nodeFill)
      .attr("stroke", nodeStroke)
      .attr("stroke-width", nodeStrokeWidth);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePatterns]);

  // Pan and zoom.
  useEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    const container = containerRef.current;
    if (!svg || !viewport || !container) return;
    if (ambient) {
      const center = () => {
        select(viewport).attr(
          "transform",
          `translate(${container.clientWidth / 2},${container.clientHeight / 2})`,
        );
      };
      center();
      const observer = new ResizeObserver(center);
      observer.observe(container);
      return () => observer.disconnect();
    }
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 6])
      .on("zoom", (event) => {
        select(viewport).attr("transform", event.transform.toString());
        // A sourceEvent means a hand on the wheel rather than our own fit
        // transition, and a camera the user has taken is not snatched back.
        if (event.sourceEvent) disarmSettleFit();
      });
    zoomRef.current = behavior;
    const sel = select(svg);
    sel.call(behavior).on("dblclick.zoom", null);
    // Center the origin right away so the graph never starts corner-anchored.
    sel.call(
      behavior.transform,
      zoomIdentity.translate(container.clientWidth / 2, container.clientHeight / 2),
    );
    sel.on("click", (event: MouseEvent) => {
      if (event.target === svg) liveRef.current.onSelect(null);
    });
    // The background is the only thing a double-click reaches, d3's own
    // dblclick zoom having been unhooked above, so it is free to mean "fit".
    sel.on("dblclick", (event: MouseEvent) => {
      if (event.target === svg) fitRef.current(600);
    });
    return () => {
      sel.on(".zoom", null).on("click", null).on("dblclick", null);
    };
  }, [ambient]);

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
      noverlap(nodesRef.current);
      simRef.current?.alpha(0.05).restart();
      window.setTimeout(() => fit(500), 60);
    },
    center: (id: string) => {
      const svg = svgRef.current;
      const container = containerRef.current;
      const behavior = zoomRef.current;
      const node = nodesRef.current.find((n) => n.id === id);
      if (!svg || !container || !behavior || !node) return;
      // Zoomed out the label would arrive unreadable, so the travel also
      // brings the scale up to one; zoomed in it stays where the reader put it.
      const k = Math.max(zoomTransform(svg).k, 1);
      const next = zoomIdentity
        .translate(
          container.clientWidth / 2 - k * (node.x ?? 0),
          container.clientHeight / 2 - k * (node.y ?? 0),
        )
        .scale(k);
      const sel = select(svg);
      if (reducedMotion.current) sel.call(behavior.transform, next);
      else sel.transition().duration(450).call(behavior.transform, next);
    },
    buildExport: () => {
      const svg = svgRef.current;
      if (!svg || nodesRef.current.length === 0) return null;
      const box = contentBounds(nodesRef.current, 70);
      return { svgText: buildSvgDocument(svg, box, liveRef.current.theme.surface), box };
    },
  }));

  // Ids for the bits the svg points at. Two canvases are never mounted at once
  // (the ambient one stands in for the real one), so a fixed id is safe, and a
  // shadow root scopes them anyway.
  const helpId = "graph-keys-help";
  return (
    <div className={ambient ? "graph-canvas ambient" : "graph-canvas"} ref={containerRef}>
      <svg
        ref={svgRef}
        className="graph-svg"
        /* Ambient it is decoration and says so; otherwise it is something to be
           operated, and "application" is what tells a screen reader to hand the
           arrow keys over rather than reading the page with them. */
        role={ambient ? "img" : "application"}
        aria-label={ambient ? "Decorative network animation" : "Network graph"}
        aria-describedby={ambient ? undefined : helpId}
      >
        <defs>
          <Arrow id="arrow-dim" fill={theme.arrowDim} />
          <Arrow id="arrow-lit" fill={theme.edgeLit} />
          <Arrow id="arrow-cn" fill={theme.neutral} />
          {arrowColors.map((c, i) => (
            <Arrow key={c} id={`arrow-c${i}`} fill={c} />
          ))}
          {[...imagePatterns].map(([source, id]) => (
            <NodeImage key={id} id={id} source={source} surface={theme.surface} />
          ))}
        </defs>
        <g ref={viewportRef} data-viewport="">
          {/* The edge hit paths sit below the nodes: they are invisible, so
              their order is purely about the pointer, and a click on a node
              must reach the node even where an edge passes under it. */}
          <g data-links="" />
          <g data-hits="" />
          <g data-nodes="" />
          <g data-labels="" />
        </g>
      </svg>
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

/**
 * A node picture, as a pattern the circles fill themselves with. Bounding-box
 * units mean the 1x1 content box is the circle's own box, so the picture lands
 * centred and cropped square at whatever radius the node has, and the mark
 * stays a plain circle: still one element to hit, drag, dim and export.
 */
function NodeImage({ id, source, surface }: { id: string; source: string; surface: string }) {
  return (
    <pattern id={id} width="1" height="1" patternContentUnits="objectBoundingBox">
      {/* Backdrop, so a transparent picture and one that has not arrived yet
          both read as the surface rather than as a hole in the graph. */}
      <rect width="1" height="1" fill={surface} />
      <image href={source} width="1" height="1" preserveAspectRatio="xMidYMid slice" />
    </pattern>
  );
}

function Arrow({ id, fill }: { id: string; fill: string }) {
  return (
    <marker
      id={id}
      viewBox="0 -4 8 8"
      refX="7"
      refY="0"
      markerWidth="9"
      markerHeight="9"
      markerUnits="userSpaceOnUse"
      orient="auto"
    >
      <path d="M0,-4L8,0L0,4" fill={fill} />
    </marker>
  );
}
