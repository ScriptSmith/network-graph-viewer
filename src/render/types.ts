import type { GraphLink, GraphNode, GraphSelection, Graph } from "../types";
import type { LayoutId } from "../lib/layouts";
import type { GraphTheme, Palette } from "../theme";
import type { ExportBox } from "../lib/export";

/** A set of marks named together: nodes by id, links by `edgeKey`. */
export interface MarkSet {
  nodes: ReadonlySet<string>;
  links: ReadonlySet<string>;
}

/**
 * Which painter draws the marks. The scene, the simulation, the keyboard and
 * the tooltips are the controller's whichever is chosen; a renderer is only
 * the drawing and the pointer's half of the interaction.
 */
export type RendererId = "svg" | "canvas" | "webgl";

export interface RendererOption {
  id: RendererId;
  name: string;
  hint: string;
}

export const RENDERERS: RendererOption[] = [
  { id: "svg", name: "SVG", hint: "Sharpest marks and SVG export; best up to a few thousand" },
  { id: "canvas", name: "Canvas", hint: "One drawing surface instead of one element per mark" },
  { id: "webgl", name: "WebGL", hint: "GPU rendering for the largest graphs" },
];

export function isRendererId(value: unknown): value is RendererId {
  return typeof value === "string" && RENDERERS.some((r) => r.id === value);
}

/**
 * Everything the appearance of one frame is derived from. Renderers read it
 * through `SharedScene.view()` at paint time rather than taking props, the way
 * the old canvas read `liveRef`: handlers and paints outlive the render that
 * created them.
 */
export interface ViewState {
  theme: GraphTheme;
  palette: Palette;
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  ranking: Graph["ranking"];
  arrows: boolean;
  layout: LayoutId;
  selectedId: string | null;
  selectedEdge: { source: string; target: string } | null;
  /** The hovered or keyboard-focused node driving neighbourhood lighting. */
  focusId: string | null;
  /** Its closed neighbourhood, when there is one. */
  neighbors: ReadonlySet<string> | null;
  /** The hovered link, lit the way a picked one is. */
  hoverLink: GraphLink | null;
  /** The keyboard focus alone, for renderers that draw their own focus ring. */
  keyboardFocusId: string | null;
  path: MarkSet | null;
  dimmed: MarkSet | null;
  pinned: ReadonlySet<string>;
  /** Which labels show before hover and selection have their say. */
  baseLabels: ReadonlySet<string>;
  /** The stroke width an edge draws at, weight scale and overrides resolved. */
  strokeWidth: (l: GraphLink) => number;
  /** Whether a node image source may be drawn at all (vetted, permitted). */
  drawable: (source: string | null) => source is string;
  /** SVG pattern ids per drawable source. */
  imagePatterns: ReadonlyMap<string, string>;
  /** Decoded images per drawable source, for the painters that draw pixels. */
  images: ReadonlyMap<string, HTMLImageElement>;
}

/** What the controller wants to hear back from whichever renderer is up. */
export interface RendererCallbacks {
  onSelect(next: GraphSelection | null): void;
  onHoverNode(d: GraphNode | null, event: MouseEvent | null): void;
  onHoverLink(l: GraphLink | null, event: MouseEvent | null): void;
  onNodeKeyDown(event: KeyboardEvent, d: GraphNode): void;
  onNodeFocus(d: GraphNode): void;
  onNodeBlur(): void;
  onDragStart(d: GraphNode): void;
  onDragMove(d: GraphNode, x: number, y: number): void;
  onDragEnd(d: GraphNode, x: number, y: number, pin: boolean): void;
  /** The hand is on the wheel: any fit still waiting on the layout lets go. */
  onUserCamera(): void;
  /** A renderer-owned simulation started, settled, paused or resumed. */
  onSimulationState(running: boolean): void;
  /** Every camera move, ours or the user's, so a renderer swap keeps the view. */
  onCameraChange(t: { x: number; y: number; k: number }): void;
  onBackgroundClick(): void;
  onBackgroundDblClick(): void;
  /**
   * A node was double-clicked. The background's own double-click still means
   * "fit", so the two never both fire: whichever the pointer was over wins.
   */
  onNodeDblClick(node: GraphNode): void;
}

/**
 * The one object a renderer holds. `scene` is mutated in place on rebuild and
 * the arrays' members are the simulation's own nodes, so reading a position at
 * paint time is reading the simulation.
 */
export interface SharedScene {
  scene: { nodes: GraphNode[]; links: GraphLink[] };
  view(): ViewState;
  callbacks: RendererCallbacks;
  reducedMotion(): boolean;
  /** The node's spoken name, for aria labels wherever the renderer puts them. */
  describeNode(d: GraphNode): string;
  /** Which node carries the tab stop when nothing has been focused yet. */
  entryNode(): string | null;
}

/**
 * What every renderer can be told to do. `build` re-joins the scene after the
 * network changed, `draw` repaints positions, `restyle` repaints appearance;
 * the split matters to the SVG renderer, which pays per attribute, and is free
 * for the raster ones, where all three end in the same full repaint.
 */
export interface RendererHandle {
  build(): void;
  draw(): void;
  restyle(): void;
  /**
   * The styled graph changed under the same structure: radii, labels, fills.
   * Split from `restyle` so a hover repaint never pays for per-node strings.
   * Renderers whose restyle is already a full repaint can leave it out.
   */
  graphChanged?(): void;
  /** Ease the view onto a box, in world coordinates. */
  fit(box: ExportBox, duration: number): void;
  /** Travel to a world point at a scale. */
  centerOn(x: number, y: number, k: number, duration: number): void;
  /** The current camera, or null before one exists. */
  transform(): { x: number; y: number; k: number } | null;
  setTransform(t: { x: number; y: number; k: number }): void;
  /** A world point in container coordinates, for tooltips and reveals. */
  screenPoint(x: number, y: number): { x: number; y: number } | null;
  /** Move the renderer's notion of keyboard focus, however it shows it. */
  focusNode(id: string | null, options?: { move?: boolean }): void;
  /** Where a tooltip should anchor for a node reached without a pointer. */
  nodeAnchor(id: string): Element | { x: number; y: number } | null;
  /** Serialize the scene as SVG. Only the SVG renderer answers. */
  exportSvg?(box: ExportBox, surface: string): string;
  /**
   * Whether this renderer owns the physics for a layout. True today only for
   * "gpu" under WebGL, where cosmos simulates on the graphics card and the
   * controller's own simulation stands down.
   */
  runsSimulation?(layout: LayoutId): boolean;
  /** Take over the physics: run, and hand positions back when settled. */
  startSimulation?(alpha: number, fitOnSettle: boolean): void;
  /** Give the physics back, positions synced onto the nodes first. */
  stopSimulation?(): void;
  /** Hold a renderer-owned simulation where it stands, keeping ownership. */
  pauseSimulation?(): void;
  /** Set it moving again. */
  resumeSimulation?(): void;
  /** Pull renderer-held positions onto the nodes, where any exist. */
  syncPositions?(): void;
}
