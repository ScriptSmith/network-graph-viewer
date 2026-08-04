/**
 * What every mark looks like right now, as pure functions of the view state.
 *
 * This is the precedence that used to live inside the SVG attribute writes: a
 * lit route mutes everything off it, the timeline's window veils what falls
 * outside it, a hover or selection mutes everything but the neighbourhood, and
 * a selected edge keeps its two ends. Every renderer asks these functions and
 * paints the answers its own way, which is what keeps three painters from
 * drifting into three opinions.
 */
import type { GraphLink, GraphNode } from "../types";
import { endpointId as endpoint, markColor } from "../lib/graph";
import { edgeKey } from "../lib/cells";
import type { LayoutId } from "../lib/layouts";
import type { ViewState } from "./types";

/**
 * Identity of a link across rebuilds and restyles: the pair of endpoints it
 * joins. Through `edgeKey`, so an id holding whatever a spreadsheet held cannot
 * collide with the pair beside it, and so the separator is spelled in exactly
 * one place.
 */
export const linkKeyOf = (l: GraphLink) => edgeKey(endpoint(l.source), endpoint(l.target));

/** What color the node stands for, image or no image. */
export function nodeTint(d: GraphNode, view: ViewState): string {
  return markColor(d, view.ranking, view.colors, view.palette);
}

/** Whether the node wears a picture, which turns its ring into the tint. */
export function nodeShowsImage(d: GraphNode, view: ViewState): boolean {
  return view.drawable(d.image);
}

function onPathNode(d: GraphNode, view: ViewState): boolean {
  return view.path?.nodes.has(d.id) ?? false;
}

export function nodeOpacity(d: GraphNode, view: ViewState): number {
  const { path, dimmed, neighbors, selectedEdge } = view;
  // A lit route mutes everything off it, the way a selection mutes the rest
  // of the graph: the answer is the route, so the route is what shows. A
  // selected edge mutes everything but its two ends the same way.
  if (path !== null) return path.nodes.has(d.id) ? 1 : 0.14;
  if (dimmed?.nodes.has(d.id)) return 0.08;
  if (neighbors) return neighbors.has(d.id) ? 1 : 0.14;
  if (selectedEdge !== null) {
    return d.id === selectedEdge.source || d.id === selectedEdge.target ? 1 : 0.14;
  }
  return 1;
}

export interface NodeRing {
  stroke: string;
  width: number;
  /** The pin, worn as a dashed ring. */
  dashed: boolean;
}

export function nodeRing(d: GraphNode, view: ViewState): NodeRing {
  const dashed = view.pinned.has(d.id);
  if (d.id === view.selectedId || onPathNode(d, view)) {
    return { stroke: view.theme.selectRing, width: 2.5, dashed };
  }
  return nodeShowsImage(d, view)
    ? { stroke: nodeTint(d, view), width: 2, dashed }
    : { stroke: view.theme.surface, width: 1.5, dashed };
}

export function edgeBase(d: GraphLink, view: ViewState): string {
  if (d.color !== null) return d.color;
  if (d.colorValue === null) return view.theme.edge;
  return view.edgeColors.get(d.colorValue) ?? view.theme.neutral;
}

function linkPicked(d: GraphLink, view: ViewState): boolean {
  const edge = view.selectedEdge;
  if (edge !== null && endpoint(d.source) === edge.source && endpoint(d.target) === edge.target) {
    return true;
  }
  return view.hoverLink === d;
}

export interface LinkPaint {
  stroke: string;
  width: number;
  opacity: number;
  /** Lit strokes take the lit arrowhead as well. */
  lit: boolean;
}

export function linkPaint(d: GraphLink, view: ViewState): LinkPaint {
  const { path, dimmed, neighbors, focusId, selectedEdge } = view;
  const picked = linkPicked(d, view);
  const onPath = path !== null && path.links.has(linkKeyOf(d));
  const touches =
    neighbors !== null && (endpoint(d.source) === focusId || endpoint(d.target) === focusId);
  const lit = picked || onPath || touches;

  let opacity: number;
  // A selected edge is lit the way a hovered one is, and keeps that whatever
  // the neighbourhood dimming would otherwise have said about it.
  if (picked || onPath) opacity = 1;
  else if (path !== null) opacity = 0.06;
  else if (dimmed !== null && dimmed.links.has(linkKeyOf(d))) opacity = 0.04;
  else if (neighbors) opacity = touches ? 0.95 : 0.06;
  else if (selectedEdge !== null) opacity = 0.06;
  else opacity = d.colorValue === null ? 0.85 : 0.9;

  return {
    stroke: lit ? view.theme.edgeLit : edgeBase(d, view),
    width: view.strokeWidth(d) * (picked || onPath ? 2.2 : 1),
    opacity,
    lit,
  };
}

export function labelVisible(d: GraphNode, view: ViewState): boolean {
  const { path, dimmed, neighbors, selectedEdge } = view;
  if (path !== null) return path.nodes.has(d.id);
  if (dimmed?.nodes.has(d.id)) return false;
  if (neighbors) return neighbors.has(d.id);
  // Selecting an edge names both of its ends and nothing else, whatever the
  // label mode: the rest of the graph is muted under it.
  if (selectedEdge !== null) return d.id === selectedEdge.source || d.id === selectedEdge.target;
  return view.baseLabels.has(d.id) || d.id === view.selectedId;
}

/** The endpoints and, for reciprocal pairs, the arc's control point. */
export interface LinkGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Quadratic control point, present only when the link curves. */
  cx?: number;
  cy?: number;
}

export function linkGeometry(l: GraphLink): LinkGeometry {
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
  if (!l.curve) return { x1, y1, x2, y2 };
  return {
    x1,
    y1,
    x2,
    y2,
    cx: (x1 + x2) / 2 - uy * dist * 0.14,
    cy: (y1 + y2) / 2 + ux * dist * 0.14,
  };
}

export function svgLinkPath(g: LinkGeometry): string {
  if (g.cx === undefined || g.cy === undefined) return `M${g.x1},${g.y1}L${g.x2},${g.y2}`;
  return `M${g.x1},${g.y1}Q${g.cx},${g.cy} ${g.x2},${g.y2}`;
}

/** On ring-shaped layouts labels radiate outward so they don't pile up. */
export function isRingLayout(layout: LayoutId): boolean {
  return layout === "circle" || layout === "radial";
}

export interface LabelPlacement {
  anchor: "start" | "middle" | "end";
  x: number;
  y: number;
}

export function labelPlacement(d: GraphNode, rings: boolean): LabelPlacement {
  const x = d.x ?? 0;
  const y = d.y ?? 0;
  if (!rings) return { anchor: "middle", x, y: y - d.radius - 6 };
  const angle = Math.atan2(y, x);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    anchor: c > 0.2 ? "start" : c < -0.2 ? "end" : "middle",
    x: x + c * (d.radius + 8),
    y: y + s * (d.radius + 8) + (s > 0.35 ? 10 : s < -0.35 ? -4 : 4),
  };
}
