/**
 * The WebGL renderer: cosmos.gl drawing the marks from typed arrays.
 *
 * The library is index-based and GPU-resident, so this adapter's whole job is
 * translation: node objects into flat position, color and size arrays, ids
 * into indices, our world coordinates into cosmos's space coordinates, and
 * cosmos's events back into the controller's callbacks. Appearance still
 * comes from the shared appearance module, folded into RGBA, which is what
 * keeps three renderers telling one story about the same graph.
 *
 * Ordinarily positions stream in from the controller's simulation, exactly
 * like the other renderers. The one layout that reverses the flow is "gpu",
 * where cosmos runs its own simulation on the graphics card and positions
 * stream back out on settle; `runsSimulation` is how the controller knows to
 * stand its own physics down.
 *
 * Known divergences, all deliberate: no in-graph labels, no per-node images,
 * reciprocal-pair arcs draw straight, and the pin's dashed ring has no GPU
 * equivalent. The tooltip, the legend, the keyboard and the exports behave
 * the same as everywhere else.
 *
 * cosmos.gl is imported dynamically: the page build serves it as a chunk
 * nobody pays for until they pick this renderer; the single-file builds fold
 * it in. Import only from `@cosmos.gl/graph` (MIT): the near-identical
 * `@cosmograph/cosmos` 3.x is CC-BY-NC licensed.
 */
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { select } from "d3-selection";
import type { Graph as CosmosGraph } from "@cosmos.gl/graph";
import type { GraphNode } from "../types";
import type { LayoutId } from "../lib/layouts";
import type { ExportBox } from "../lib/export";
import { linkPaint, nodeOpacity, nodeTint } from "./appearance";
import type { RendererHandle, SharedScene } from "./types";

/**
 * cosmos positions live in [0, spaceSize] with y up and are clamped to it by
 * the simulation, so every world coordinate has to land well inside; ours are
 * centred on the origin with y down, the way SVG reads. The default space is
 * the one size no device shrinks. The mapping itself is per scene: centred on
 * the layout, scaled down when its extent would not fit, and held fixed until
 * the next build so the camera never watches the space move under it.
 */
const SPACE = 4096;
const HALF = SPACE / 2;
/** How much of the space a scene may fill, leaving room for a layout to grow. */
const SPACE_HEADROOM = 0.5;
/** cosmos's own equilibrium spacing, in space units per node of a settled run. */
const GPU_NODE_SPACING = 10;

interface SpaceMap {
  cx: number;
  cy: number;
  scale: number;
}

/** Hex colors and an alpha into the RGBA floats cosmos reads. */
function pushRgba(out: Float32Array, at: number, hex: string, alpha: number): void {
  let r = 0.7;
  let g = 0.7;
  let b = 0.7;
  if (hex.startsWith("#") && (hex.length === 7 || hex.length === 4)) {
    const full = hex.length === 7 ? hex : `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    r = parseInt(full.slice(1, 3), 16) / 255;
    g = parseInt(full.slice(3, 5), 16) / 255;
    b = parseInt(full.slice(5, 7), 16) / 255;
  }
  out[at] = r;
  out[at + 1] = g;
  out[at + 2] = b;
  out[at + 3] = alpha;
}

interface WebglSceneProps {
  shared: SharedScene;
  /**
   * WebGL turned out not to work here after all: the device failed where the
   * cheap probe passed. The app answers by falling back to canvas.
   */
  onFailed: () => void;
  ref?: Ref<RendererHandle>;
}

export function WebglScene({ shared, onFailed, ref }: WebglSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<CosmosGraph | null>(null);
  const indexOfRef = useRef<Map<string, number>>(new Map());
  const focusedRef = useRef<string | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  const hoveredLinkRef = useRef<number | null>(null);
  const lastPointerRef = useRef<MouseEvent | null>(null);
  const draggingRef = useRef<GraphNode | null>(null);
  const fitOnSettleRef = useRef(false);
  const simulatingRef = useRef(false);
  const tickRef = useRef(0);
  // Calls that arrived before the library finished loading, replayed in order.
  const queueRef = useRef<(() => void)[]>([]);
  const failedRef = useRef(false);
  const mapRef = useRef<SpaceMap>({ cx: 0, cy: 0, scale: 1 });

  const toSpaceX = (x: number) => HALF + (x - mapRef.current.cx) * mapRef.current.scale;
  const toSpaceY = (y: number) => HALF - (y - mapRef.current.cy) * mapRef.current.scale;
  const toWorldX = (sx: number) => mapRef.current.cx + (sx - HALF) / mapRef.current.scale;
  const toWorldY = (sy: number) => mapRef.current.cy - (sy - HALF) / mapRef.current.scale;

  /**
   * The GPU simulation settles at cosmos's own coordinate scale, not ours, so
   * the mapping is re-derived from what it actually produced: the settled
   * extent is read back and assigned a world extent sized the way our own
   * force layout would size it. Everything downstream (mark sizes, sync,
   * drags, tooltips) reads the mapping, so it all agrees at once.
   */
  /**
   * The settled run assigned a world extent sized the way our own force
   * layout would size it. Only worth calling once the simulation has stopped
   * moving: mid-flight the extent is still travelling, and normalizing
   * against it would swing every mark's size around for nothing.
   */
  const remapFromSpace = () => {
    const graph = graphRef.current;
    if (!graph || !openRef.current) return;
    const positions = graph.getPointPositions();
    const count = Math.floor(positions.length / 2);
    if (count === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      minX = Math.min(minX, positions[i * 2]);
      maxX = Math.max(maxX, positions[i * 2]);
      minY = Math.min(minY, positions[i * 2 + 1]);
      maxY = Math.max(maxY, positions[i * 2 + 1]);
    }
    const spaceExtent = Math.max(maxX - minX, maxY - minY);
    if (!isFinite(spaceExtent) || spaceExtent <= 0) return;
    // Roughly the spread our d3 force layout gives the same node count.
    const targetExtent = Math.max(600, 120 * Math.sqrt(count));
    const scale = spaceExtent / targetExtent;
    const scx = (minX + maxX) / 2;
    const scy = (minY + maxY) / 2;
    mapRef.current = {
      scale,
      cx: (HALF - scx) / scale,
      cy: (scy - HALF) / scale,
    };
  };

  /** The nodes' world footprint: centre and widest side. */
  const worldBounds = (): { cx: number; cy: number; extent: number } | null => {
    const nodes = shared.scene.nodes;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    if (!isFinite(minX)) return null;
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      extent: Math.max(maxX - minX, maxY - minY, 1),
    };
  };

  /** Centre the space on the layout, shrinking it only when it would not fit. */
  const remapSpace = () => {
    const bounds = worldBounds();
    if (bounds === null) {
      mapRef.current = { cx: 0, cy: 0, scale: 1 };
      return;
    }
    mapRef.current = {
      cx: bounds.cx,
      cy: bounds.cy,
      scale: Math.min(1, (SPACE * SPACE_HEADROOM) / bounds.extent),
    };
  };

  /**
   * Keep the reader's view identical across a mapping change: the world point
   * under the viewport's centre stays there, at the same apparent size. The
   * marks move in space when the mapping moves; the camera follows them
   * exactly, so nothing on screen appears to happen at all.
   */
  const holdCamera = (before: SpaceMap) => {
    const graph = graphRef.current;
    const host = hostRef.current;
    if (!graph || !host || !openRef.current) return;
    const [sx, sy] = graph.screenToSpacePosition([host.clientWidth / 2, host.clientHeight / 2]);
    const wx = before.cx + (sx - HALF) / before.scale;
    const wy = before.cy - (sy - HALF) / before.scale;
    const zoom = graph.getZoomLevel() * (mapRef.current.scale / before.scale);
    graph.setZoomTransformByPointPositions(new Float32Array([toSpaceX(wx), toSpaceY(wy)]), 0, zoom);
  };

  // The device initializes asynchronously, and cosmos's own `isReady` flips
  // true partway through: the data stores its setters write into arrive later
  // in the same continuation. The `ready` promise is the only signal that the
  // whole instance exists, so nothing touches it before that resolves.
  const openRef = useRef(false);

  const run = (task: () => void) => {
    if (failedRef.current) return;
    if (openRef.current) task();
    else queueRef.current.push(task);
  };

  /** The GPU's positions written back onto the controller's nodes. */
  const syncPositions = () => {
    const graph = graphRef.current;
    if (!graph || !openRef.current) return;
    const positions = graph.getPointPositions();
    const nodes = shared.scene.nodes;
    for (let i = 0; i < nodes.length && i * 2 + 1 < positions.length; i++) {
      nodes[i].x = toWorldX(positions[i * 2]);
      nodes[i].y = toWorldY(positions[i * 2 + 1]);
    }
  };

  const positionsArray = (): Float32Array => {
    const nodes = shared.scene.nodes;
    const out = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      out[i * 2] = toSpaceX(nodes[i].x ?? 0);
      out[i * 2 + 1] = toSpaceY(nodes[i].y ?? 0);
    }
    return out;
  };

  const restyle = () =>
    run(() => {
      const graph = graphRef.current;
      if (!graph) return;
      const view = shared.view();
      const { nodes, links } = shared.scene;

      // Point sizes are space units and ride the same scale the positions do,
      // so a remapped layout keeps its proportions. Link widths are screen
      // pixels to cosmos and pass through untouched: an edge here keeps its
      // weight readable at any zoom rather than scaling with it.
      const scale = mapRef.current.scale;
      const pointColors = new Float32Array(nodes.length * 4);
      const pointSizes = new Float32Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        pushRgba(pointColors, i * 4, nodeTint(nodes[i], view), nodeOpacity(nodes[i], view));
        pointSizes[i] = nodes[i].radius * 2 * scale;
      }
      graph.setPointColors(pointColors);
      graph.setPointSizes(pointSizes);

      const linkColors = new Float32Array(links.length * 4);
      const linkWidths = new Float32Array(links.length);
      for (let i = 0; i < links.length; i++) {
        const paint = linkPaint(links[i], view);
        pushRgba(linkColors, i * 4, paint.stroke, paint.opacity);
        linkWidths[i] = paint.width;
      }
      graph.setLinkColors(linkColors);
      graph.setLinkWidths(linkWidths);
      graph.setLinkArrows(links.map(() => view.arrows));

      const focused =
        view.keyboardFocusId === null ? undefined : indexOfRef.current.get(view.keyboardFocusId);
      graph.setConfigPartial({
        focusedPointIndex: focused,
        focusedPointRingColor: view.theme.selectRing,
        hoveredPointRingColor: view.theme.selectRing,
      });
      graph.render(undefined, 0);
    });

  // Not queued: draws stream in per simulation tick, and replaying a backlog
  // of identical frames after init would only thrash. The queued build paints
  // the current positions the moment the device arrives.
  const draw = () => {
    if (!openRef.current || simulatingRef.current) return;
    const graph = graphRef.current;
    if (!graph) return;
    graph.setPointPositions(positionsArray(), true);
    graph.render(undefined, 0);
  };

  const build = () =>
    run(() => {
      const graph = graphRef.current;
      if (!graph) return;
      const { nodes, links } = shared.scene;
      const indexOf = new Map<string, number>();
      nodes.forEach((n, i) => indexOf.set(n.id, i));
      indexOfRef.current = indexOf;
      hoveredIndexRef.current = null;
      hoveredLinkRef.current = null;

      remapSpace();
      graph.setPointPositions(positionsArray(), true);
      const pairs = new Float32Array(links.length * 2);
      for (let i = 0; i < links.length; i++) {
        pairs[i * 2] = indexOf.get((links[i].source as GraphNode).id) ?? 0;
        pairs[i * 2 + 1] = indexOf.get((links[i].target as GraphNode).id) ?? 0;
      }
      graph.setLinks(pairs);
      graph.render(undefined, 0);
    });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let graph: CosmosGraph | null = null;

    void (async () => {
      try {
        const { Graph } = await import("@cosmos.gl/graph");
        if (cancelled) return;
        graph = new Graph(host, {
          enableSimulation: false,
          spaceSize: SPACE,
          rescalePositions: false,
          backgroundColor: [0, 0, 0, 0],
          fitViewOnInit: false,
          scalePointsOnZoom: true,
          pointSizeScale: 1,
          linkWidthScale: 1,
          // No renderer of ours fades an edge by its length; opacity is the
          // appearance module's to decide, the same everywhere.
          linkVisibilityMinTransparency: 1,
          // Cool faster than cosmos's default, which simmers long past the
          // point a layout is telling anyone anything new.
          simulationDecay: 1200,
          curvedLinks: false,
          enableDrag: true,
          renderHoveredPointRing: true,
          hoveredPointCursor: "pointer",
          onClick: (index, _position, event) => {
            if (index !== undefined) {
              const node = shared.scene.nodes[index];
              if (node) shared.callbacks.onSelect({ kind: "node", id: node.id });
              return;
            }
            const link =
              hoveredLinkRef.current === null
                ? undefined
                : shared.scene.links[hoveredLinkRef.current];
            if (link) {
              shared.callbacks.onSelect({
                kind: "edge",
                source: (link.source as GraphNode).id,
                target: (link.target as GraphNode).id,
              });
              return;
            }
            lastPointerRef.current = event;
            shared.callbacks.onBackgroundClick();
          },
          onPointMouseOver: (index, _position, event) => {
            hoveredIndexRef.current = index;
            const node = shared.scene.nodes[index];
            if (node) {
              shared.callbacks.onHoverNode(
                node,
                event instanceof MouseEvent ? event : lastPointerRef.current,
              );
            }
          },
          onPointMouseOut: () => {
            hoveredIndexRef.current = null;
            shared.callbacks.onHoverNode(null, null);
          },
          onLinkMouseOver: (linkIndex) => {
            hoveredLinkRef.current = linkIndex;
            const link = shared.scene.links[linkIndex];
            if (link) shared.callbacks.onHoverLink(link, lastPointerRef.current);
          },
          onLinkMouseOut: () => {
            hoveredLinkRef.current = null;
            shared.callbacks.onHoverLink(null, null);
          },
          onZoom: (_event, userDriven) => {
            if (userDriven) {
              // A camera the user has taken is not snatched back, mid-run
              // refits included.
              fitOnSettleRef.current = false;
              shared.callbacks.onUserCamera();
            }
          },
          onSimulationTick: () => {
            // While the run is on its way to settling, the camera follows so
            // the whole layout stays framed. Nothing is remapped mid-flight:
            // the marks were sized for the settle scale before the run began.
            tickRef.current += 1;
            if (tickRef.current % 40 !== 0) return;
            if (fitOnSettleRef.current) graphRef.current?.fitView(200, 0.1);
          },
          onSimulationStart: () => shared.callbacks.onSimulationState(true),
          onSimulationUnpause: () => shared.callbacks.onSimulationState(true),
          onDragStart: () => {
            const index = hoveredIndexRef.current;
            const node = index === null ? undefined : shared.scene.nodes[index];
            if (!node) return;
            draggingRef.current = node;
            shared.callbacks.onDragStart(node);
          },
          onDrag: (event) => {
            const node = draggingRef.current;
            const graphNow = graphRef.current;
            if (!node || !graphNow || !openRef.current) return;
            const [sx, sy] = graphNow.screenToSpacePosition([event.x, event.y]);
            shared.callbacks.onDragMove(node, toWorldX(sx), toWorldY(sy));
          },
          onDragEnd: (event) => {
            const node = draggingRef.current;
            draggingRef.current = null;
            const graphNow = graphRef.current;
            if (!node || !graphNow || !openRef.current) return;
            const source = event.sourceEvent as unknown;
            const pin = source instanceof MouseEvent && source.shiftKey;
            const [sx, sy] = graphNow.screenToSpacePosition([event.x, event.y]);
            if (simulatingRef.current) syncPositions();
            shared.callbacks.onDragEnd(node, toWorldX(sx), toWorldY(sy), pin);
          },
          onSimulationEnd: () => {
            remapFromSpace();
            syncPositions();
            restyle();
            if (fitOnSettleRef.current) {
              fitOnSettleRef.current = false;
              graphRef.current?.fitView(shared.reducedMotion() ? 0 : 500, 0.1);
            }
            shared.callbacks.onSimulationState(false);
          },
          onSimulationPause: () => {
            remapFromSpace();
            syncPositions();
            shared.callbacks.onSimulationState(false);
          },
        });
        graphRef.current = graph;
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__ngvCosmos = graph;
        }
        // Methods queue inside cosmos until the device exists, but a device
        // that never arrives should say so rather than render nothing.
        void graph.ready.then(
          () => {
            if (cancelled) return;
            openRef.current = true;
            // cosmos's own double-click zoom gives way, so a double-click
            // means what it means under every other renderer: fit.
            const surface = host.querySelector("canvas");
            if (surface) select(surface).on("dblclick.zoom", null);
            const queued = queueRef.current;
            queueRef.current = [];
            for (const task of queued) task();
            draw();
          },
          (reason: unknown) => {
            if (!cancelled) {
              failedRef.current = true;
              // The fallback is silent in the UI beyond a notice, so the
              // reason must at least reach whoever opens the console.
              console.error("The WebGL renderer could not start.", reason);
              onFailed();
            }
          },
        );
      } catch (reason) {
        if (!cancelled) {
          failedRef.current = true;
          console.error("The WebGL renderer could not start.", reason);
          onFailed();
        }
      }
    })();

    const onMove = (event: MouseEvent) => {
      lastPointerRef.current = event;
    };
    const onDblClick = () => {
      if (hoveredIndexRef.current === null && hoveredLinkRef.current === null) {
        shared.callbacks.onBackgroundDblClick();
      }
    };
    // Keyboard: the same one-tab-stop model the canvas renderer keeps.
    const onKeyDown = (event: KeyboardEvent) => {
      const focused = focusedRef.current;
      const nodes = shared.scene.nodes;
      const current = focused === null ? undefined : nodes.find((n) => n.id === focused);
      if (current) {
        shared.callbacks.onNodeKeyDown(event, current);
        return;
      }
      if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const entry = shared.entryNode();
        const node = entry === null ? undefined : nodes.find((n) => n.id === entry);
        if (node) {
          event.preventDefault();
          event.stopPropagation();
          shared.callbacks.onNodeFocus(node);
        }
      }
    };
    const onFocus = () => {
      let byKeyboard = false;
      try {
        byKeyboard = host.matches(":focus-visible");
      } catch {
        byKeyboard = true;
      }
      if (!byKeyboard) return;
      const entry = focusedRef.current ?? shared.entryNode();
      const node = entry === null ? undefined : shared.scene.nodes.find((n) => n.id === entry);
      if (node) shared.callbacks.onNodeFocus(node);
    };
    const onBlur = () => shared.callbacks.onNodeBlur();
    host.addEventListener("mousemove", onMove);
    host.addEventListener("dblclick", onDblClick);
    host.addEventListener("keydown", onKeyDown);
    host.addEventListener("focus", onFocus);
    host.addEventListener("blur", onBlur);

    return () => {
      cancelled = true;
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("dblclick", onDblClick);
      host.removeEventListener("keydown", onKeyDown);
      host.removeEventListener("focus", onFocus);
      host.removeEventListener("blur", onBlur);
      // A GPU simulation's last word goes back onto the nodes, so whichever
      // renderer comes next starts from the layout the reader was seeing.
      if (simulatingRef.current) syncPositions();
      graphRef.current = null;
      graph?.destroy();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    build,
    draw,
    restyle,
    fit(_box: ExportBox, duration: number) {
      run(() => graphRef.current?.fitView(shared.reducedMotion() ? 0 : duration, 0.1));
    },
    centerOn(x: number, y: number, k: number, duration: number) {
      run(() =>
        graphRef.current?.setZoomTransformByPointPositions(
          new Float32Array([toSpaceX(x), toSpaceY(y)]),
          shared.reducedMotion() ? 0 : duration,
          k,
        ),
      );
    },
    // cosmos owns its camera; there is no d3 transform to carry to or from
    // the other renderers, so a swap in or out of WebGL refits instead.
    transform: () => null,
    setTransform: () => {},
    screenPoint(x: number, y: number) {
      const graph = graphRef.current;
      if (!graph || !openRef.current) return null;
      const [sx, sy] = graph.spaceToScreenPosition([toSpaceX(x), toSpaceY(y)]);
      return { x: sx, y: sy };
    },
    focusNode(id, options = {}) {
      const host = hostRef.current;
      focusedRef.current = id;
      if (!host) return;
      if (id === null) {
        host.removeAttribute("data-nodes");
        host.setAttribute("aria-label", "Network graph");
      } else {
        // Worn only while a node holds the keyboard, so the app's single-key
        // shortcuts stand down exactly then.
        host.setAttribute("data-nodes", "");
        const node = shared.scene.nodes.find((n) => n.id === id);
        if (node) host.setAttribute("aria-label", shared.describeNode(node));
        if (options.move !== false) host.focus({ preventScroll: true });
      }
      restyle();
    },
    nodeAnchor(id) {
      const graph = graphRef.current;
      const node = shared.scene.nodes.find((n) => n.id === id);
      if (!graph || !openRef.current || !node) return null;
      const [sx, sy] = graph.spaceToScreenPosition([toSpaceX(node.x ?? 0), toSpaceY(node.y ?? 0)]);
      return { x: sx, y: sy + node.radius * mapRef.current.scale * graph.getZoomLevel() };
    },
    runsSimulation(layout: LayoutId) {
      return layout === "gpu";
    },
    startSimulation(alpha: number, fitOnSettle: boolean) {
      run(() => {
        const graph = graphRef.current;
        if (!graph) return;
        simulatingRef.current = true;
        fitOnSettleRef.current = fitOnSettle;
        const pinned = shared.view().pinned;
        const indices: number[] = [];
        for (const [id, index] of indexOfRef.current) {
          if (pinned.has(id)) indices.push(index);
        }
        // The run starts already mapped to where it is going. cosmos settles
        // at close to a constant spacing per node whatever the graph, so the
        // settle scale is predictable at handover; starting there means the
        // marks are sized for the destination rather than the departure, and
        // the end-of-run correction is a few percent instead of a lurch. The
        // camera is held exactly still across the change.
        const bounds = worldBounds();
        if (bounds) {
          const count = Math.max(shared.scene.nodes.length, 1);
          const targetExtent = Math.max(600, 120 * Math.sqrt(count));
          const before = { ...mapRef.current };
          mapRef.current = {
            cx: bounds.cx,
            cy: bounds.cy,
            scale: (GPU_NODE_SPACING * Math.sqrt(count)) / targetExtent,
          };
          holdCamera(before);
        }
        graph.setPointPositions(positionsArray(), true);
        restyle();
        graph.setConfigPartial({ enableSimulation: true });
        graph.setPinnedPoints(indices.length > 0 ? indices : null);
        graph.start(alpha);
      });
    },
    stopSimulation() {
      run(() => {
        const graph = graphRef.current;
        if (!graph || !simulatingRef.current) return;
        simulatingRef.current = false;
        fitOnSettleRef.current = false;
        graph.pause();
        remapFromSpace();
        syncPositions();
        graph.setConfigPartial({ enableSimulation: false });
      });
    },
    pauseSimulation() {
      run(() => graphRef.current?.pause());
    },
    resumeSimulation() {
      // start() rather than unpause(): it resumes a paused run and reheats a
      // settled one, which is what "resume" should mean in both states.
      run(() => graphRef.current?.start(0.3));
    },
    syncPositions() {
      if (simulatingRef.current) syncPositions();
    },
  }));

  return (
    <div
      ref={hostRef}
      className="graph-svg graph-raster graph-webgl"
      tabIndex={0}
      role="application"
      aria-label="Network graph"
      aria-describedby="graph-keys-help"
    />
  );
}
