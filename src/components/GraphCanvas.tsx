import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
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
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { drag } from "d3-drag";
import "d3-transition";
import type { Graph, GraphLink, GraphNode, GraphStyle, LabelMode, Row } from "../types";
import {
  computeTargets,
  forceAtlas2,
  forceAtlas2Params,
  layoutWeightColumn,
  noverlap,
  type LayoutId,
  type LayoutParams,
} from "../lib/layouts";
import { endpointId as endpoint, weightScale } from "../lib/graph";
import { buildSvgDocument, contentBounds, type ExportBox } from "../lib/export";
import { formatMetric } from "../lib/format";
import {
  CATEGORICAL,
  EDGE,
  EDGE_LIT,
  LABEL,
  LABEL_HALO,
  NEUTRAL,
  SELECT_RING,
  SURFACE,
  nodeColor,
  sequentialColor,
} from "../theme";

export interface GraphCanvasHandle {
  fit: () => void;
  reheat: () => void;
  /** Nudge overlapping nodes apart in place, leaving the layout otherwise alone. */
  separate: () => void;
  buildExport: () => { svgText: string; box: ExportBox } | null;
}

interface GraphCanvasProps {
  graph: Graph;
  layout: LayoutId;
  layoutParams: LayoutParams;
  /** Targets for the "script" layout, produced by a user layout script. */
  scriptedTargets?: Map<string, { x: number; y: number }> | null;
  preventOverlap: boolean;
  labelMode: LabelMode;
  style: GraphStyle;
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  attrColumns: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
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
  ref?: Ref<GraphCanvasHandle>;
}

const ARROW = "#5d5c55";

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

/** Marker id matching an edge stroke color; markers are pre-defined per slot. */
function markerFor(stroke: string): string {
  if (stroke === EDGE_LIT) return "url(#arrow-lit)";
  if (stroke === NEUTRAL) return "url(#arrow-cn)";
  const slot = CATEGORICAL.indexOf(stroke);
  return slot === -1 ? "url(#arrow-dim)" : `url(#arrow-c${slot})`;
}

export function GraphCanvas({
  graph,
  layout,
  layoutParams,
  scriptedTargets,
  preventOverlap,
  labelMode,
  style,
  colors,
  edgeColors,
  attrColumns,
  selectedId,
  onSelect,
  seedPositions,
  ambient = false,
  ref,
}: GraphCanvasProps) {
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
  const baseLabelsRef = useRef<Set<string>>(new Set());
  const hoverNodeRef = useRef<string | null>(null);

  const edgeWidth = useMemo(() => weightScale(graph.links), [graph]);

  // Live values for callbacks created inside effects.
  const liveRef = useRef({
    layout,
    layoutParams,
    scriptedTargets,
    preventOverlap,
    labelMode,
    selectedId,
    onSelect,
    colors,
    edgeColors,
    attrColumns,
    ambient,
    style,
  });
  liveRef.current = {
    layout,
    layoutParams,
    scriptedTargets,
    preventOverlap,
    labelMode,
    selectedId,
    onSelect,
    colors,
    edgeColors,
    attrColumns,
    ambient,
    style,
  };

  const nodeFill = (d: GraphNode): string => {
    if (graph.ranking) {
      const span = graph.ranking.max - graph.ranking.min || 1;
      return sequentialColor(((d.value ?? graph.ranking.min) - graph.ranking.min) / span);
    }
    return nodeColor(d.group, liveRef.current.colors);
  };

  const edgeBase = (d: GraphLink): string => {
    if (d.colorValue === null) return EDGE;
    return liveRef.current.edgeColors.get(d.colorValue) ?? NEUTRAL;
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
    const { selectedId: sel, style: st } = liveRef.current;
    const focus = hoverNodeRef.current ?? sel;
    const neighbors = focus ? adjacencyRef.current.get(focus) : null;
    const base = baseLabelsRef.current;

    sels.node
      .attr("opacity", (d) => (neighbors && !neighbors.has(d.id) ? 0.14 : 1))
      .attr("stroke", (d) => (d.id === sel ? SELECT_RING : SURFACE))
      .attr("stroke-width", (d) => (d.id === sel ? 2.5 : 1.5));

    sels.link
      .attr("stroke", (d) => {
        const lit = neighbors && (endpoint(d.source) === focus || endpoint(d.target) === focus);
        return lit ? EDGE_LIT : edgeBase(d);
      })
      .attr("opacity", (d) => {
        if (!neighbors) return d.colorValue === null ? 0.85 : 0.9;
        const touches = endpoint(d.source) === focus || endpoint(d.target) === focus;
        return touches ? 0.95 : 0.06;
      })
      .attr("marker-end", (d) => {
        if (!st.arrows) return null;
        const lit = neighbors && (endpoint(d.source) === focus || endpoint(d.target) === focus);
        return markerFor(lit ? EDGE_LIT : edgeBase(d));
      });

    sels.label.attr("display", (d) => {
      if (neighbors) return neighbors.has(d.id) ? null : "none";
      return base.has(d.id) || d.id === sel ? null : "none";
    });
  };

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

  const applyLayoutForces = (kick: number) => {
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
        n.fx = null;
        n.fy = null;
      }
      sim
        .force("x", forceX<GraphNode>((d) => d.tx ?? 0).strength(0.3))
        .force("y", forceY<GraphNode>((d) => d.ty ?? 0).strength(0.3));
    } else {
      for (const n of nodes) {
        n.fx = null;
        n.fy = null;
      }
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
    sim.alpha(kick).restart();
  };

  const fit = (duration = 600) => {
    const container = containerRef.current;
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!container || !svg || !behavior || nodesRef.current.length === 0) return;
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

  const showTooltip = (event: MouseEvent, html: string) => {
    const tip = tooltipRef.current;
    const container = containerRef.current;
    if (!tip || !container) return;
    tip.innerHTML = html;
    tip.style.display = "block";
    const rect = container.getBoundingClientRect();
    let x = event.clientX - rect.left + 16;
    let y = event.clientY - rect.top + 12;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    if (x + tw > rect.width - 8) x = event.clientX - rect.left - tw - 12;
    if (y + th > rect.height - 8) y = event.clientY - rect.top - th - 10;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };

  const hideTooltip = () => {
    const tip = tooltipRef.current;
    if (tip) tip.style.display = "none";
  };

  const nodeTooltip = (d: GraphNode): string => {
    const group = d.group ? `<div class="tip-sub">${escapeHtml(d.group)}</div>` : "";
    const value =
      graph.ranking && d.value !== null
        ? `<div class="tip-sub">${escapeHtml(formatMetric(d.value))}</div>`
        : "";
    return (
      `<div class="tip-title">${escapeHtml(d.id)}</div>${group}${value}` +
      `<div class="tip-meta">${d.inDegree} in · ${d.outDegree} out</div>`
    );
  };

  const linkTooltip = (l: GraphLink): string => {
    const { attrColumns: attrs } = liveRef.current;
    const head = `<div class="tip-title">${escapeHtml(endpoint(l.source))} → ${escapeHtml(endpoint(l.target))}</div>`;
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

  // Rebuild the scene when the graph changes.
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

    const { ambient: amb, style: st } = liveRef.current;
    const root = select(viewport);
    const linkLayer = root.select<SVGGElement>("[data-links]");
    const hitLayer = root.select<SVGGElement>("[data-hits]");
    const nodeLayer = root.select<SVGGElement>("[data-nodes]");
    const labelLayer = root.select<SVGGElement>("[data-labels]");

    const linkKey = (l: GraphLink) => `${endpoint(l.source)}\u001F${endpoint(l.target)}`;

    const link = linkLayer
      .selectAll<SVGPathElement, GraphLink>("path")
      .data(links, linkKey)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => edgeBase(d))
      .attr("stroke-width", (d) => edgeWidth(d))
      .attr("stroke-linecap", "round")
      .attr("marker-end", (d) => (amb || !st.arrows ? null : markerFor(edgeBase(d))));

    const hit = hitLayer
      .selectAll<SVGPathElement, GraphLink>("path")
      .data(amb ? [] : links, linkKey)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 11)
      .on("mouseenter", (event: MouseEvent, d) => {
        showTooltip(event, linkTooltip(d));
        link
          .filter((l) => l === d)
          .attr("stroke", EDGE_LIT)
          .attr("opacity", 1)
          .attr("marker-end", liveRef.current.style.arrows ? "url(#arrow-lit)" : null);
      })
      .on("mousemove", (event: MouseEvent, d) => showTooltip(event, linkTooltip(d)))
      .on("mouseleave", () => {
        hideTooltip();
        refreshStyles();
      });

    const node = nodeLayer
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes, (d) => d.id)
      .join("circle")
      .attr("data-id", (d) => d.id)
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => nodeFill(d))
      .attr("stroke", SURFACE)
      .attr("stroke-width", 1.5)
      .style("cursor", amb ? "default" : "pointer");

    const label = labelLayer
      .selectAll<SVGTextElement, GraphNode>("text")
      .data(amb ? [] : nodes, (d) => d.id)
      .join("text")
      .text((d) => d.id)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("font-weight", 500)
      .attr("fill", LABEL)
      .attr("stroke", LABEL_HALO)
      .attr("stroke-width", 3.5)
      .attr("paint-order", "stroke")
      .attr("pointer-events", "none");

    selsRef.current = { node, link, hit, label };

    if (!amb) {
      node
        .on("mouseenter", (event: MouseEvent, d) => {
          hoverNodeRef.current = d.id;
          refreshStyles();
          showTooltip(event, nodeTooltip(d));
        })
        .on("mousemove", (event: MouseEvent, d) => showTooltip(event, nodeTooltip(d)))
        .on("mouseleave", () => {
          hoverNodeRef.current = null;
          refreshStyles();
          hideTooltip();
        })
        .on("click", (event: MouseEvent, d) => {
          event.stopPropagation();
          liveRef.current.onSelect(d.id);
        });

      node.call(
        drag<SVGCircleElement, GraphNode>()
          .on("start", (_event, d) => {
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
            if (liveRef.current.layout === "force" || liveRef.current.layout === "forceatlas2") {
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

    const sim = forceSimulation<GraphNode, GraphLink>(nodes)
      .velocityDecay(amb ? 0.35 : 0.45)
      .on("tick", () => {
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
      });
    if (amb) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!still) sim.alphaDecay(0.002).alphaMin(0);
    }
    simRef.current?.stop();
    simRef.current = sim;

    computeBaseLabels();
    applyLayoutForces(1);
    refreshStyles();

    const timer = window.setTimeout(() => fit(650), 700);
    return () => {
      window.clearTimeout(timer);
      sim.stop();
    };
    // The scene is rebuilt only when the graph itself changes; everything
    // else flows through liveRef.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Layout and spacing switches morph the existing scene.
  const firstLayoutRun = useRef(true);
  useEffect(() => {
    if (firstLayoutRun.current) {
      firstLayoutRun.current = false;
      return;
    }
    applyLayoutForces(0.9);
    // Physics layouts are still spreading at 700ms, so fit once early for
    // feedback and again once the simulation has actually settled.
    const early = window.setTimeout(() => fit(650), 700);
    const settled = window.setTimeout(() => fit(500), 2600);
    return () => {
      window.clearTimeout(early);
      window.clearTimeout(settled);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, layoutParams, preventOverlap, style.spacing]);

  useEffect(() => {
    computeBaseLabels();
    refreshStyles();
  }, [labelMode, selectedId, graph, style.arrows]);

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
      if (event.target === svg) fit(600);
    });
    return () => {
      sel.on(".zoom", null).on("click", null).on("dblclick", null);
    };
  }, [ambient]);

  useImperativeHandle(ref, () => ({
    fit: () => fit(600),
    reheat: () => {
      applyLayoutForces(0.9);
    },
    separate: () => {
      noverlap(nodesRef.current);
      simRef.current?.alpha(0.05).restart();
      window.setTimeout(() => fit(500), 60);
    },
    buildExport: () => {
      const svg = svgRef.current;
      if (!svg || nodesRef.current.length === 0) return null;
      const box = contentBounds(nodesRef.current, 70);
      return { svgText: buildSvgDocument(svg, box), box };
    },
  }));

  return (
    <div className={ambient ? "graph-canvas ambient" : "graph-canvas"} ref={containerRef}>
      <svg ref={svgRef} className="graph-svg" role="img" aria-label="Network graph">
        <defs>
          <Arrow id="arrow-dim" fill={ARROW} />
          <Arrow id="arrow-lit" fill={EDGE_LIT} />
          <Arrow id="arrow-cn" fill={NEUTRAL} />
          {CATEGORICAL.map((c, i) => (
            <Arrow key={c} id={`arrow-c${i}`} fill={c} />
          ))}
        </defs>
        <g ref={viewportRef} data-viewport="">
          <g data-links="" />
          <g data-nodes="" />
          <g data-labels="" />
          <g data-hits="" />
        </g>
      </svg>
      {!ambient && <div className="graph-tooltip" ref={tooltipRef} />}
    </div>
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
