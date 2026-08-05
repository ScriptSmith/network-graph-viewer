/**
 * The canvas renderer: the same scene as one drawing surface.
 *
 * Every frame is a full repaint, which is what makes this the fast renderer:
 * there is no per-mark DOM to build or restyle, so `build`, `draw` and
 * `restyle` all end in the same paint. Picking is geometric, against the same
 * positions the paint reads. Keyboard focus lives on the canvas element itself,
 * one tab stop for the whole graph, and the focused node wears a drawn ring;
 * the `data-nodes` attribute comes and goes with that focus so the app's
 * single-key shortcuts give way exactly while someone is walking the graph.
 *
 * `paintScene` is exported on purpose: the PNG export paints the same scene
 * into an offscreen canvas at export scale, whichever renderer is live.
 */
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3-zoom";
import { drag } from "d3-drag";
import "d3-transition";
import type { GraphLink, GraphNode } from "../types";
import type { ExportBox } from "../lib/export";
import { linkGeometry } from "./appearance";
import { paintScene } from "./paint";
import type { RendererHandle, SharedScene } from "./types";

/** Distance from a point to a segment, for edge picking. */
function segmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

interface CanvasSceneProps {
  shared: SharedScene;
  ref?: Ref<RendererHandle>;
}

export function CanvasScene({ shared, ref }: CanvasSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const draggingRef = useRef(false);
  const focusedRef = useRef<string | null>(null);
  /**
   * Whether the surface has been given its once-only initial centering. A ref
   * rather than a fact recomputed in the effect, because StrictMode re-runs a
   * mount's effects after the controller has already restored the camera a
   * swap carried over, and a second centering would throw that camera away.
   */
  const centeredRef = useRef(false);

  const draw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const t = zoomTransform(canvas);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
    paintScene(ctx, shared.scene.nodes, shared.scene.links, shared.view());
  };

  /** World coordinates of a pointer event on the canvas. */
  const worldPoint = (event: MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const t = zoomTransform(canvas);
    const [x, y] = t.invert([event.clientX - rect.left, event.clientY - rect.top]);
    return { x, y };
  };

  const pickNode = (wx: number, wy: number): GraphNode | null => {
    const canvas = canvasRef.current;
    const k = canvas ? zoomTransform(canvas).k : 1;
    const slop = 2 / k;
    const nodes = shared.scene.nodes;
    // Backwards, so where marks overlap the one drawn on top wins.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const d = nodes[i];
      const r = d.radius + slop;
      const dx = wx - (d.x ?? 0);
      const dy = wy - (d.y ?? 0);
      if (dx * dx + dy * dy <= r * r) return d;
    }
    return null;
  };

  const pickLink = (wx: number, wy: number): GraphLink | null => {
    const canvas = canvasRef.current;
    const k = canvas ? zoomTransform(canvas).k : 1;
    const view = shared.view();
    // The same reach the SVG hit paths give: 11 screen pixels of stroke.
    const reach = 5.5 / k;
    let best: GraphLink | null = null;
    let bestDistance = Infinity;
    for (const l of shared.scene.links) {
      const g = linkGeometry(l);
      const tolerance = Math.max(view.strokeWidth(l) / 2, reach);
      // A cheap box test first: most edges are nowhere near the pointer.
      const minX = Math.min(g.x1, g.x2, g.cx ?? g.x1) - tolerance;
      const maxX = Math.max(g.x1, g.x2, g.cx ?? g.x1) + tolerance;
      const minY = Math.min(g.y1, g.y2, g.cy ?? g.y1) - tolerance;
      const maxY = Math.max(g.y1, g.y2, g.cy ?? g.y1) + tolerance;
      if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;
      let distance: number;
      if (g.cx === undefined || g.cy === undefined) {
        distance = segmentDistance(wx, wy, g.x1, g.y1, g.x2, g.y2);
      } else {
        // Close enough for picking: the arc as a handful of segments.
        distance = Infinity;
        let px = g.x1;
        let py = g.y1;
        for (let s = 1; s <= 8; s++) {
          const t = s / 8;
          const mt = 1 - t;
          const qx = mt * mt * g.x1 + 2 * mt * t * g.cx + t * t * g.x2;
          const qy = mt * mt * g.y1 + 2 * mt * t * g.cy + t * t * g.y2;
          distance = Math.min(distance, segmentDistance(wx, wy, px, py, qx, qy));
          px = qx;
          py = qy;
        }
      }
      if (distance <= tolerance && distance < bestDistance) {
        best = l;
        bestDistance = distance;
      }
    }
    return best;
  };

  // Size the backing store to the element, in device pixels.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      draw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pointer wiring: zoom, drag, hover, click. Installed once; everything they
  // read is reached through refs, the way the SVG renderer's handlers are.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sel = select(canvas);

    const behavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 6])
      // A press on a node belongs to the drag; everything else pans.
      .filter((event: MouseEvent | WheelEvent) => {
        if (event.type === "wheel") return true;
        if ((event as MouseEvent).button) return false;
        if (event.type === "mousedown" || event.type === "touchstart") {
          const w = worldPoint(event as MouseEvent);
          return pickNode(w.x, w.y) === null;
        }
        return true;
      })
      .on("zoom", (event) => {
        draw();
        shared.callbacks.onCameraChange(event.transform);
        if (event.sourceEvent) shared.callbacks.onUserCamera();
      });
    zoomRef.current = behavior;
    sel.call(behavior).on("dblclick.zoom", null);
    if (!centeredRef.current) {
      centeredRef.current = true;
      sel.call(
        behavior.transform,
        zoomIdentity.translate(canvas.clientWidth / 2, canvas.clientHeight / 2),
      );
    }

    let grabbed: { node: GraphNode; dx: number; dy: number } | null = null;
    sel.call(
      drag<HTMLCanvasElement, unknown>()
        .subject((event) => {
          const w = worldPoint(event.sourceEvent as MouseEvent);
          const node = pickNode(w.x, w.y);
          if (!node) return null as unknown as object;
          grabbed = { node, dx: (node.x ?? 0) - w.x, dy: (node.y ?? 0) - w.y };
          return node;
        })
        .on("start", () => {
          if (!grabbed) return;
          draggingRef.current = true;
          shared.callbacks.onDragStart(grabbed.node);
        })
        .on("drag", (event) => {
          if (!grabbed) return;
          const w = worldPoint(event.sourceEvent as MouseEvent);
          shared.callbacks.onDragMove(grabbed.node, w.x + grabbed.dx, w.y + grabbed.dy);
        })
        .on("end", (event) => {
          if (!grabbed) return;
          draggingRef.current = false;
          const w = worldPoint(event.sourceEvent as MouseEvent);
          const pin =
            event.sourceEvent instanceof MouseEvent && (event.sourceEvent as MouseEvent).shiftKey;
          shared.callbacks.onDragEnd(grabbed.node, w.x + grabbed.dx, w.y + grabbed.dy, pin);
          grabbed = null;
        }),
    );

    const onMove = (event: MouseEvent) => {
      if (draggingRef.current) return;
      const w = worldPoint(event);
      const node = pickNode(w.x, w.y);
      if (node) {
        canvas.style.cursor = "pointer";
        // A link hovered a moment ago stays lit unless it is let go of here:
        // the pointer can land on a node without ever crossing empty space.
        shared.callbacks.onHoverLink(null, null);
        shared.callbacks.onHoverNode(node, event);
        return;
      }
      const link = pickLink(w.x, w.y);
      canvas.style.cursor = link ? "pointer" : "";
      shared.callbacks.onHoverNode(null, null);
      shared.callbacks.onHoverLink(link, link ? event : null);
    };
    const onLeave = () => {
      shared.callbacks.onHoverNode(null, null);
      shared.callbacks.onHoverLink(null, null);
    };
    const onClick = (event: MouseEvent) => {
      const w = worldPoint(event);
      const node = pickNode(w.x, w.y);
      if (node) {
        shared.callbacks.onSelect({ kind: "node", id: node.id });
        return;
      }
      const link = pickLink(w.x, w.y);
      if (link) {
        shared.callbacks.onSelect({
          kind: "edge",
          source: (link.source as GraphNode).id,
          target: (link.target as GraphNode).id,
        });
        return;
      }
      shared.callbacks.onBackgroundClick();
    };
    const onDblClick = (event: MouseEvent) => {
      const w = worldPoint(event);
      if (pickNode(w.x, w.y) === null) shared.callbacks.onBackgroundDblClick();
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("dblclick", onDblClick);

    // Keyboard: the canvas is the one tab stop, and the controller's model
    // does the walking. Arriving by keyboard enters the graph at the entry
    // node; arriving by click does not steal the pointer's meaning.
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
        byKeyboard = canvas.matches(":focus-visible");
      } catch {
        byKeyboard = true;
      }
      if (!byKeyboard) return;
      const entry = focusedRef.current ?? shared.entryNode();
      const node = entry === null ? undefined : shared.scene.nodes.find((n) => n.id === entry);
      if (node) shared.callbacks.onNodeFocus(node);
    };
    const onBlur = () => shared.callbacks.onNodeBlur();
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("focus", onFocus);
    canvas.addEventListener("blur", onBlur);

    return () => {
      sel.on(".zoom", null).on(".drag", null);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("focus", onFocus);
      canvas.removeEventListener("blur", onBlur);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTransform = (t: { x: number; y: number; k: number }, duration: number) => {
    const canvas = canvasRef.current;
    const behavior = zoomRef.current;
    if (!canvas || !behavior) return;
    const sel = select(canvas);
    const target = zoomIdentity.translate(t.x, t.y).scale(t.k);
    if (duration > 0 && !shared.reducedMotion()) {
      sel.transition().duration(duration).call(behavior.transform, target);
    } else {
      sel.call(behavior.transform, target);
    }
  };

  useImperativeHandle(ref, () => ({
    build: draw,
    draw,
    restyle: draw,
    fit(box: ExportBox, duration: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const k = Math.max(0.05, Math.min(w / box.width, h / box.height, 1.5));
      applyTransform(
        {
          x: w / 2 - k * (box.x + box.width / 2),
          y: h / 2 - k * (box.y + box.height / 2),
          k,
        },
        duration,
      );
    },
    centerOn(x: number, y: number, k: number, duration: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      applyTransform(
        { x: canvas.clientWidth / 2 - k * x, y: canvas.clientHeight / 2 - k * y, k },
        duration,
      );
    },
    transform() {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const t = zoomTransform(canvas);
      return { x: t.x, y: t.y, k: t.k };
    },
    setTransform(t) {
      applyTransform(t, 0);
    },
    screenPoint(x: number, y: number) {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const [sx, sy] = zoomTransform(canvas).apply([x, y]);
      return { x: sx, y: sy };
    },
    focusNode(id, options = {}) {
      const canvas = canvasRef.current;
      focusedRef.current = id;
      if (!canvas) return;
      if (id === null) {
        canvas.removeAttribute("data-nodes");
        canvas.setAttribute("aria-label", "Network graph");
        draw();
        return;
      }
      // The attribute is what tells the app's single-key shortcuts to stand
      // down: it is worn only while a node actually has the keyboard.
      canvas.setAttribute("data-nodes", "");
      const node = shared.scene.nodes.find((n) => n.id === id);
      if (node) canvas.setAttribute("aria-label", shared.describeNode(node));
      if (options.move !== false) canvas.focus({ preventScroll: true });
      draw();
    },
    nodeAnchor(id) {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const node = shared.scene.nodes.find((n) => n.id === id);
      if (!node) return null;
      const t = zoomTransform(canvas);
      const [sx, sy] = t.apply([node.x ?? 0, node.y ?? 0]);
      return { x: sx, y: sy + node.radius * t.k };
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="graph-svg graph-raster"
      tabIndex={0}
      role="application"
      aria-label="Network graph"
      aria-describedby="graph-keys-help"
    />
  );
}
