/**
 * The SVG renderer: one element per mark, joined and repainted by d3.
 *
 * React renders the shell and the defs; d3 owns the joins and every attribute
 * write. Marks are styled with SVG attributes, never CSS classes, so a clone
 * of the live element is a faithful export, and this renderer is the only one
 * that can answer `exportSvg`. It is also the one whose nodes are real
 * focusable elements, so keyboard focus here is genuine DOM focus with the
 * browser's own ring and a screen reader's own reporting.
 */
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { select, type Selection } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3-zoom";
import { drag } from "d3-drag";
import "d3-transition";
import type { GraphLink, GraphNode } from "../types";
import type { GraphTheme } from "../theme";
import { buildSvgDocument, type ExportBox } from "../lib/export";
import {
  isRingLayout,
  labelPlacement,
  labelVisible,
  linkGeometry,
  linkKeyOf,
  linkPaint,
  nodeOpacity,
  nodeRing,
  nodeTint,
  svgLinkPath,
} from "./appearance";
import type { RendererHandle, SharedScene } from "./types";

type NodeSel = Selection<SVGCircleElement, GraphNode, SVGGElement, unknown>;
type LinkSel = Selection<SVGPathElement, GraphLink, SVGGElement, unknown>;
type LabelSel = Selection<SVGTextElement, GraphNode, SVGGElement, unknown>;

/** Marker id matching an edge stroke color; markers are pre-defined per color. */
function markerFor(stroke: string, arrowColors: string[], theme: GraphTheme): string {
  if (stroke === theme.edgeLit) return "url(#arrow-lit)";
  if (stroke === theme.neutral) return "url(#arrow-cn)";
  const slot = arrowColors.indexOf(stroke);
  return slot === -1 ? "url(#arrow-dim)" : `url(#arrow-c${slot})`;
}

interface SvgSceneProps {
  shared: SharedScene;
  ambient: boolean;
  theme: GraphTheme;
  arrowColors: string[];
  /** One pattern per distinct drawable image source. */
  imagePatterns: ReadonlyMap<string, string>;
  ref?: Ref<RendererHandle>;
}

export function SvgScene({
  shared,
  ambient,
  theme,
  arrowColors,
  imagePatterns,
  ref,
}: SvgSceneProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const selsRef = useRef<{ node: NodeSel; link: LinkSel; hit: LinkSel; label: LabelSel } | null>(
    null,
  );
  // Live copies for the handlers d3 installs once.
  const live = useRef({ theme, arrowColors, imagePatterns });
  live.current = { theme, arrowColors, imagePatterns };

  const imageFill = (d: GraphNode): string | null => {
    const id = d.image === null ? undefined : live.current.imagePatterns.get(d.image);
    return id === undefined ? null : `url(#${id})`;
  };

  // A pictured node keeps its colour as a ring, so an image never costs the
  // reader whatever the colours were encoding.
  const nodeFill = (d: GraphNode): string => imageFill(d) ?? nodeTint(d, shared.view());

  const restyle = () => {
    const sels = selsRef.current;
    if (!sels) return;
    const view = shared.view();

    sels.node
      .attr("opacity", (d) => nodeOpacity(d, view))
      .attr("stroke", (d) => nodeRing(d, view).stroke)
      .attr("stroke-width", (d) => nodeRing(d, view).width)
      // The pin is worn as a dashed ring: an attribute on the same circle, so
      // it survives export and the node stays one mark to hit and drag.
      .attr("stroke-dasharray", (d) => (nodeRing(d, view).dashed ? "3 3" : null));

    sels.link
      .attr("stroke", (d) => linkPaint(d, view).stroke)
      .attr("stroke-width", (d) => linkPaint(d, view).width)
      .attr("opacity", (d) => linkPaint(d, view).opacity)
      .attr("marker-end", (d) => {
        // The ambient background never wears arrowheads, whatever the style.
        if (ambient || !view.arrows) return null;
        const paint = linkPaint(d, view);
        return markerFor(paint.stroke, live.current.arrowColors, view.theme);
      });

    // Colours as well as visibility: a theme change repaints through here,
    // and the labels were given their fill once, when the scene was built.
    sels.label
      .attr("fill", view.theme.label)
      .attr("stroke", view.theme.labelHalo)
      .attr("display", (d) => (labelVisible(d, view) ? null : "none"));
  };

  const draw = () => {
    const sels = selsRef.current;
    if (!sels) return;
    const view = shared.view();
    sels.link.attr("d", (d) => svgLinkPath(linkGeometry(d)));
    sels.hit.attr("d", (d) => svgLinkPath(linkGeometry(d)));
    sels.node.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
    const rings = isRingLayout(view.layout);
    sels.label
      .attr("text-anchor", (d) => labelPlacement(d, rings).anchor)
      .attr("x", (d) => labelPlacement(d, rings).x)
      .attr("y", (d) => labelPlacement(d, rings).y);
  };

  const build = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const { nodes, links } = shared.scene;
    const view = shared.view();
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
      .attr("stroke-linecap", "round");

    const hit = hitLayer
      .selectAll<SVGPathElement, GraphLink>("path")
      .data(ambient ? [] : links, linkKeyOf)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 11)
      .style("cursor", "pointer")
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        shared.callbacks.onSelect({
          kind: "edge",
          source: (d.source as GraphNode).id,
          target: (d.target as GraphNode).id,
        });
      })
      .on("mouseenter", (event: MouseEvent, d) => shared.callbacks.onHoverLink(d, event))
      .on("mousemove", (event: MouseEvent, d) => shared.callbacks.onHoverLink(d, event))
      .on("mouseleave", () => shared.callbacks.onHoverLink(null, null));

    const node = nodeLayer
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes, (d) => d.id)
      .join("circle")
      .attr("data-id", (d) => d.id)
      .attr("r", (d) => d.radius)
      .attr("fill", nodeFill)
      .style("cursor", ambient ? "default" : "pointer");

    if (!ambient) {
      // Exactly one node is in the tab order at a time. Reaching the graph puts
      // focus on the most connected node, which is the one worth arriving at.
      const entry = shared.entryNode();
      node
        .attr("role", "button")
        .attr("aria-label", (d) => shared.describeNode(d))
        .attr("tabindex", (d) => (d.id === entry ? 0 : null));

      node
        .on("mouseenter", (event: MouseEvent, d) => shared.callbacks.onHoverNode(d, event))
        .on("mousemove", (event: MouseEvent, d) => shared.callbacks.onHoverNode(d, event))
        .on("mouseleave", () => shared.callbacks.onHoverNode(null, null))
        .on("click", (event: MouseEvent, d) => {
          event.stopPropagation();
          shared.callbacks.onSelect({ kind: "node", id: d.id });
        })
        // Focus does what hover does, so the graph reads the same whether it is
        // being pointed at or tabbed through.
        .on("focus", (_event: FocusEvent, d) => shared.callbacks.onNodeFocus(d))
        .on("blur", () => shared.callbacks.onNodeBlur())
        .on("keydown", (event: KeyboardEvent, d) => shared.callbacks.onNodeKeyDown(event, d));

      node.call(
        drag<SVGCircleElement, GraphNode>()
          .on("start", (_event, d) => shared.callbacks.onDragStart(d))
          .on("drag", (event, d) => shared.callbacks.onDragMove(d, event.x, event.y))
          .on("end", (event, d) => {
            const pin = event.sourceEvent instanceof MouseEvent && event.sourceEvent.shiftKey;
            shared.callbacks.onDragEnd(d, event.x, event.y, pin);
          }),
      );
    }

    const label = labelLayer
      .selectAll<SVGTextElement, GraphNode>("text")
      .data(ambient ? [] : nodes, (d) => d.id)
      .join("text")
      .text((d) => d.label)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("font-weight", 500)
      .attr("fill", view.theme.label)
      .attr("stroke", view.theme.labelHalo)
      .attr("stroke-width", 3.5)
      .attr("paint-order", "stroke")
      .attr("pointer-events", "none");

    selsRef.current = { node, link, hit, label };
    restyle();
    draw();
  };

  /**
   * The writes a styled-graph change needs and a hover repaint must not pay
   * for: radii, label text, spoken names, and the fills that may now point at
   * a different pattern. `restyle` stays cheap because this is separate.
   */
  const graphChanged = () => {
    const sels = selsRef.current;
    if (!sels) return;
    const view = shared.view();
    sels.node
      .attr("r", (d) => d.radius)
      .attr("fill", nodeFill)
      .attr("stroke", (d) => nodeRing(d, view).stroke)
      .attr("stroke-width", (d) => nodeRing(d, view).width);
    sels.label.text((d) => d.label);
    if (!ambient) sels.node.attr("aria-label", (d) => shared.describeNode(d));
  };

  // A pattern that has just been dropped from the defs must stop being named
  // before anything paints, or the node it filled would come out blank. This
  // fires for permission and dead-image changes too, which never pass through
  // the controller's graph effect.
  useLayoutEffect(() => {
    const sels = selsRef.current;
    if (!sels) return;
    const view = shared.view();
    sels.node
      .attr("fill", nodeFill)
      .attr("stroke", (d) => nodeRing(d, view).stroke)
      .attr("stroke-width", (d) => nodeRing(d, view).width);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePatterns]);

  // Pan and zoom.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (!svg || !viewport) return;
    const container = svg.parentElement;
    if (ambient) {
      const center = () => {
        select(viewport).attr(
          "transform",
          `translate(${(container?.clientWidth ?? 0) / 2},${(container?.clientHeight ?? 0) / 2})`,
        );
      };
      center();
      const observer = new ResizeObserver(center);
      if (container) observer.observe(container);
      return () => observer.disconnect();
    }
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 6])
      .on("zoom", (event) => {
        select(viewport).attr("transform", event.transform.toString());
        shared.callbacks.onCameraChange(event.transform);
        // A sourceEvent means a hand on the wheel rather than our own fit
        // transition, and a camera the user has taken is not snatched back.
        if (event.sourceEvent) shared.callbacks.onUserCamera();
      });
    zoomRef.current = behavior;
    const sel = select(svg);
    sel.call(behavior).on("dblclick.zoom", null);
    // Center the origin right away so the graph never starts corner-anchored.
    sel.call(
      behavior.transform,
      zoomIdentity.translate((container?.clientWidth ?? 0) / 2, (container?.clientHeight ?? 0) / 2),
    );
    sel.on("click", (event: MouseEvent) => {
      if (event.target === svg) shared.callbacks.onBackgroundClick();
    });
    // The background is the only thing a double-click reaches, d3's own
    // dblclick zoom having been unhooked above, so it is free to mean "fit".
    sel.on("dblclick", (event: MouseEvent) => {
      if (event.target === svg) shared.callbacks.onBackgroundDblClick();
    });
    return () => {
      sel.on(".zoom", null).on("click", null).on("dblclick", null);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ambient]);

  useImperativeHandle(ref, () => ({
    build,
    draw,
    restyle,
    graphChanged,
    fit(box: ExportBox, duration: number) {
      const svg = svgRef.current;
      const behavior = zoomRef.current;
      const container = svg?.parentElement;
      if (!svg || !behavior || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const k = Math.max(0.05, Math.min(w / box.width, h / box.height, 1.5));
      const t = zoomIdentity
        .translate(w / 2, h / 2)
        .scale(k)
        .translate(-(box.x + box.width / 2), -(box.y + box.height / 2));
      const sel = select(svg);
      if (duration > 0 && !shared.reducedMotion()) {
        sel.transition().duration(duration).call(behavior.transform, t);
      } else {
        sel.call(behavior.transform, t);
      }
    },
    centerOn(x: number, y: number, k: number, duration: number) {
      const svg = svgRef.current;
      const behavior = zoomRef.current;
      const container = svg?.parentElement;
      if (!svg || !behavior || !container) return;
      const t = zoomIdentity
        .translate(container.clientWidth / 2 - k * x, container.clientHeight / 2 - k * y)
        .scale(k);
      const sel = select(svg);
      if (duration > 0 && !shared.reducedMotion()) {
        sel.transition().duration(duration).call(behavior.transform, t);
      } else {
        sel.call(behavior.transform, t);
      }
    },
    transform() {
      const svg = svgRef.current;
      if (!svg || !zoomRef.current) return null;
      const t = zoomTransform(svg);
      return { x: t.x, y: t.y, k: t.k };
    },
    setTransform(t) {
      const svg = svgRef.current;
      const behavior = zoomRef.current;
      if (!svg || !behavior) return;
      select(svg).call(behavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
    },
    screenPoint(x: number, y: number) {
      const svg = svgRef.current;
      if (!svg) return null;
      const [sx, sy] = zoomTransform(svg).apply([x, y]);
      return { x: sx, y: sy };
    },
    focusNode(id, options = {}) {
      const sels = selsRef.current;
      if (!sels) return;
      sels.node.attr("tabindex", (d) => (d.id === id ? 0 : null));
      if (id === null) return;
      const element = sels.node.filter((d) => d.id === id).node();
      if (options.move !== false) element?.focus({ preventScroll: true });
    },
    nodeAnchor(id) {
      const sels = selsRef.current;
      if (!sels) return null;
      return sels.node.filter((d) => d.id === id).node();
    },
    exportSvg(box: ExportBox, surface: string) {
      const svg = svgRef.current;
      if (!svg) return "";
      return buildSvgDocument(svg, box, surface);
    },
  }));

  return (
    <svg
      ref={svgRef}
      className="graph-svg"
      /* Ambient it is decoration and says so; otherwise it is something to be
         operated, and "application" is what tells a screen reader to hand the
         arrow keys over rather than reading the page with them. */
      role={ambient ? "img" : "application"}
      aria-label={ambient ? "Decorative network animation" : "Network graph"}
      aria-describedby={ambient ? undefined : "graph-keys-help"}
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
