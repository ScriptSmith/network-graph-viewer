/**
 * The canvas 2D paint pass: the whole scene, in world coordinates, from the
 * shared appearance functions. The live canvas renderer runs it per frame;
 * the PNG export runs the same code into an offscreen canvas at export scale,
 * whichever renderer is live, so a picture of the graph is always a fresh
 * painting and never a screenshot.
 */
import type { GraphLink, GraphNode } from "../types";
import { GRAPH_FONT } from "../theme";
import { isRemoteSource } from "../lib/images";
import {
  isRingLayout,
  labelPlacement,
  labelVisible,
  linkGeometry,
  linkPaint,
  nodeOpacity,
  nodeRing,
  nodeTint,
  type LinkGeometry,
} from "./appearance";
import type { ViewState } from "./types";

export interface PaintOptions {
  /** Leave out anything that would taint the surface, so PNG encoding works. */
  exportSafe?: boolean;
}

/** How long the drawn arrowhead is, matching the SVG marker's on-screen size. */
const ARROW_LENGTH = 9;
const ARROW_HALF_WIDTH = 4.5;

function addArrowhead(path: Path2D, g: LinkGeometry): void {
  // The tangent at the end of the arc, or the line's own direction.
  const fromX = g.cx ?? g.x1;
  const fromY = g.cy ?? g.y1;
  const dx = g.x2 - fromX;
  const dy = g.y2 - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const bx = g.x2 - ux * ARROW_LENGTH;
  const by = g.y2 - uy * ARROW_LENGTH;
  path.moveTo(g.x2, g.y2);
  path.lineTo(bx - uy * ARROW_HALF_WIDTH, by + ux * ARROW_HALF_WIDTH);
  path.lineTo(bx + uy * ARROW_HALF_WIDTH, by - ux * ARROW_HALF_WIDTH);
  path.closePath();
}

/**
 * Paint the whole scene in world coordinates. The caller owns the transform
 * and the clear, which is how the same code serves the live canvas and the
 * offscreen export.
 */
interface LinkBatch {
  stroke: string;
  width: number;
  opacity: number;
  lines: Path2D;
  arrows: Path2D | null;
}

export function paintScene(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  links: GraphLink[],
  view: ViewState,
  options: PaintOptions = {},
): void {
  ctx.lineCap = "round";
  // Links batch by their paint: one stroke call per style rather than one per
  // edge, which is the difference between a frame and a lock-up at a few
  // hundred thousand edges. Widths quantize into the key so a continuous
  // weight scale cannot fan the batches back out into one per link.
  const batches = new Map<string, LinkBatch>();
  for (const l of links) {
    const paint = linkPaint(l, view);
    const width = Math.round(paint.width * 20) / 20;
    const key = `${paint.stroke}|${width}|${paint.opacity}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        stroke: paint.stroke,
        width,
        opacity: paint.opacity,
        lines: new Path2D(),
        arrows: view.arrows ? new Path2D() : null,
      };
      batches.set(key, batch);
    }
    const g = linkGeometry(l);
    batch.lines.moveTo(g.x1, g.y1);
    if (g.cx === undefined || g.cy === undefined) batch.lines.lineTo(g.x2, g.y2);
    else batch.lines.quadraticCurveTo(g.cx, g.cy, g.x2, g.y2);
    if (batch.arrows) addArrowhead(batch.arrows, g);
  }
  for (const batch of batches.values()) {
    ctx.globalAlpha = batch.opacity;
    ctx.strokeStyle = batch.stroke;
    ctx.lineWidth = batch.width;
    ctx.stroke(batch.lines);
    if (batch.arrows) {
      ctx.fillStyle = batch.stroke;
      ctx.fill(batch.arrows);
    }
  }

  for (const d of nodes) {
    const x = d.x ?? 0;
    const y = d.y ?? 0;
    const ring = nodeRing(d, view);
    ctx.globalAlpha = nodeOpacity(d, view);
    const image =
      d.image !== null && view.drawable(d.image) && !(options.exportSafe && isRemoteSource(d.image))
        ? view.images.get(d.image)
        : undefined;
    ctx.beginPath();
    ctx.arc(x, y, d.radius, 0, Math.PI * 2);
    if (image) {
      // The picture fills the circle the way the SVG pattern does: cropped to
      // cover, over a surface backdrop so transparency reads as surface.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = view.theme.surface;
      ctx.fill();
      const iw = image.naturalWidth || 1;
      const ih = image.naturalHeight || 1;
      const scale = Math.max((d.radius * 2) / iw, (d.radius * 2) / ih);
      ctx.drawImage(image, x - (iw * scale) / 2, y - (ih * scale) / 2, iw * scale, ih * scale);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(x, y, d.radius, 0, Math.PI * 2);
    } else {
      ctx.fillStyle = nodeTint(d, view);
      ctx.fill();
    }
    ctx.strokeStyle = ring.stroke;
    ctx.lineWidth = ring.width;
    if (ring.dashed) ctx.setLineDash([3, 3]);
    ctx.stroke();
    if (ring.dashed) ctx.setLineDash([]);
    if (d.id === view.keyboardFocusId) {
      // The browser's focus ring cannot reach a drawn mark, so the renderer
      // wears one itself.
      ctx.beginPath();
      ctx.arc(x, y, d.radius + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = view.theme.selectRing;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  ctx.font = `500 11px ${GRAPH_FONT}`;
  ctx.lineJoin = "round";
  const rings = isRingLayout(view.layout);
  for (const d of nodes) {
    if (!labelVisible(d, view)) continue;
    const place = labelPlacement(d, rings);
    ctx.textAlign = place.anchor === "middle" ? "center" : place.anchor;
    ctx.strokeStyle = view.theme.labelHalo;
    ctx.lineWidth = 3.5;
    ctx.strokeText(d.label, place.x, place.y);
    ctx.fillStyle = view.theme.label;
    ctx.fillText(d.label, place.x, place.y);
  }
}
