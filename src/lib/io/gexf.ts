import type { Column, GraphDoc, Graph, GraphStyle, Row } from "../../types";
import { styleColumn } from "../../types";
import { cellToId } from "../cells";
import { DEFAULT_NODE_ID_COLUMN, hasColumn } from "../doc";
import { DEFAULT_COLORS, NEUTRAL, type Palette } from "../../theme";
import { markColor } from "../graph";
import {
  cellToText,
  coerce,
  columnTypeFrom,
  declaredTypeFor,
  parseXml,
  serialize,
  tableFrom,
  uniqueName,
} from "./xml";
import type { ImportedGraph } from "./types";

/**
 * GEXF, the format Gephi reads and writes. Node ids in the wild are often
 * meaningless counters with the real name in `label`, so labels become our
 * node ids when they are present and distinct, and edge endpoints are mapped
 * through. Positions, sizes and colours in the `viz` namespace are read on
 * import and written on export, so a file opened in Gephi looks like it did
 * here rather than being re-laid-out from scratch.
 */

const VIZ_NS = "http://gexf.net/1.3/viz";
const GEXF_NS = "http://gexf.net/1.3";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

interface AttributeDef {
  column: Column;
}

function readAttributeDefs(
  graph: Element,
  scope: "node" | "edge",
  taken: Set<string>,
): Map<string, AttributeDef> {
  const defs = new Map<string, AttributeDef>();
  for (const block of graph.querySelectorAll("attributes")) {
    if (block.getAttribute("class") !== scope) continue;
    for (const attribute of block.querySelectorAll("attribute")) {
      const id = attribute.getAttribute("id");
      if (id === null) continue;
      const title = attribute.getAttribute("title") ?? id;
      defs.set(id, {
        column: {
          name: uniqueName(taken, title),
          type: columnTypeFrom(attribute.getAttribute("type")),
        },
      });
    }
  }
  return defs;
}

function readAttValues(element: Element, defs: Map<string, AttributeDef>, row: Row): void {
  for (const value of element.querySelectorAll("attvalues > attvalue")) {
    const def = defs.get(value.getAttribute("for") ?? "");
    if (!def) continue;
    row[def.column.name] = coerce(value.getAttribute("value") ?? "", def.column.type);
  }
}

export function parseGexf(text: string, name: string): ImportedGraph {
  const xml = parseXml(text, "GEXF");
  const graph = xml.querySelector("graph");
  if (!graph) throw new Error("That GEXF file has no <graph> element.");

  const nodeTaken = new Set<string>([DEFAULT_NODE_ID_COLUMN]);
  const nodeDefs = readAttributeDefs(graph, "node", nodeTaken);
  const edgeTaken = new Set<string>(["Source", "Target"]);
  const edgeDefs = readAttributeDefs(graph, "edge", edgeTaken);

  const elements = [...graph.querySelectorAll("nodes > node")];
  const rawIds = elements.map((n) => n.getAttribute("id") ?? "");
  const labels = elements.map((n) => n.getAttribute("label") ?? "");
  // Prefer labels as ids, but only when every one is present and distinct.
  const useLabels =
    labels.length > 0 &&
    labels.every((l) => l.trim() !== "") &&
    new Set(labels).size === labels.length;
  const nameOf = new Map<string, string>();
  elements.forEach((_, i) => nameOf.set(rawIds[i], useLabels ? labels[i] : rawIds[i]));

  const positions = new Map<string, { x: number; y: number }>();
  const nodeRows: Row[] = [];
  const labelColumn = useLabels
    ? null
    : { name: uniqueName(nodeTaken, "Label"), type: "text" as const };

  elements.forEach((element, i) => {
    const id = nameOf.get(rawIds[i]) as string;
    const row: Row = { [DEFAULT_NODE_ID_COLUMN]: id };
    if (labelColumn && labels[i] !== "") row[labelColumn.name] = labels[i];
    readAttValues(element, nodeDefs, row);

    const position = element.getElementsByTagNameNS(VIZ_NS, "position")[0];
    if (position) {
      const x = Number(position.getAttribute("x"));
      const y = Number(position.getAttribute("y"));
      if (isFinite(x) && isFinite(y)) positions.set(id, { x, y });
    }
    nodeRows.push(row);
  });

  const edgeRows: Row[] = [];
  let weightColumn: Column | null = null;
  for (const element of graph.querySelectorAll("edges > edge")) {
    const source = nameOf.get(element.getAttribute("source") ?? "");
    const target = nameOf.get(element.getAttribute("target") ?? "");
    if (source === undefined || target === undefined) continue;
    const row: Row = { Source: source, Target: target };
    const weight = element.getAttribute("weight");
    if (weight !== null && weight !== "") {
      weightColumn ??= { name: uniqueName(edgeTaken, "Weight"), type: "number" };
      row[weightColumn.name] = Number(weight);
    }
    readAttValues(element, edgeDefs, row);
    edgeRows.push(row);
  }

  const nodeColumns: Column[] = [
    { name: DEFAULT_NODE_ID_COLUMN, type: "text" },
    ...(labelColumn ? [labelColumn] : []),
    ...[...nodeDefs.values()].map((d) => d.column),
  ];
  const edgeColumns: Column[] = [
    { name: "Source", type: "text" },
    { name: "Target", type: "text" },
    ...(weightColumn ? [weightColumn] : []),
    ...[...edgeDefs.values()].map((d) => d.column),
  ];

  const doc: GraphDoc = {
    name,
    nodes: tableFrom("Nodes", nodeColumns, nodeRows),
    edges: tableFrom("Edges", edgeColumns, edgeRows),
    nodeIdColumn: DEFAULT_NODE_ID_COLUMN,
    mapping: {
      source: "Source",
      target: "Target",
      attrs: edgeColumns.slice(2).map((c) => c.name),
    },
    nodesDeclared: true,
  };
  return { doc, positions: positions.size > 0 ? positions : undefined };
}

/** #rrggbb to the r/g/b attributes GEXF's viz namespace expects. */
function rgbOf(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16) || 0,
    g: parseInt(value.slice(2, 4), 16) || 0,
    b: parseInt(value.slice(4, 6), 16) || 0,
  };
}

export interface GexfExportOptions {
  doc: GraphDoc;
  /** The styled graph, which supplies positions, radii and colours. */
  graph: Graph;
  style: GraphStyle;
  /** The palette in force; defaults to the shipped one. */
  palette?: Palette;
  colors: Map<string, string>;
}

export function writeGexf({
  doc,
  graph,
  style,
  palette = DEFAULT_COLORS,
  colors,
}: GexfExportOptions): string {
  // createDocument already puts the root in the GEXF namespace; setting xmlns
  // by hand as well would serialize a duplicate attribute and fail to reparse.
  const xml = document.implementation.createDocument(GEXF_NS, "gexf", null);
  const root = xml.documentElement;
  root.setAttributeNS(XMLNS_NS, "xmlns:viz", VIZ_NS);
  root.setAttribute("version", "1.3");
  const make = (name: string) => xml.createElementNS(GEXF_NS, name);

  const meta = make("meta");
  const description = make("description");
  description.textContent = doc.name;
  meta.appendChild(description);
  root.appendChild(meta);

  const graphEl = make("graph");
  graphEl.setAttribute("defaultedgetype", "directed");
  root.appendChild(graphEl);

  const nodeAttrs = doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn);
  const edgeAttrs = doc.edges.columns.filter(
    (c) => c.name !== doc.mapping.source && c.name !== doc.mapping.target,
  );

  const declare = (scope: "node" | "edge", columns: Column[]) => {
    if (columns.length === 0) return;
    const block = make("attributes");
    block.setAttribute("class", scope);
    columns.forEach((column, i) => {
      const attribute = make("attribute");
      attribute.setAttribute("id", `${scope}${i}`);
      attribute.setAttribute("title", column.name);
      attribute.setAttribute("type", declaredTypeFor(column.type));
      block.appendChild(attribute);
    });
    graphEl.appendChild(block);
  };
  declare("node", nodeAttrs);
  declare("edge", edgeAttrs);

  const attValues = (row: Row, scope: "node" | "edge", columns: Column[]): Element | null => {
    const written = columns
      .map((column, i) => ({ column, i }))
      .filter(({ column }) => row[column.name] !== null && row[column.name] !== undefined);
    if (written.length === 0) return null;
    const block = make("attvalues");
    for (const { column, i } of written) {
      const value = make("attvalue");
      value.setAttribute("for", `${scope}${i}`);
      value.setAttribute("value", cellToText(row[column.name]));
      block.appendChild(value);
    }
    return block;
  };

  // Every node is looked up twice below, once for its geometry and once for its
  // colour, so the index comes first: finding each by a scan would make writing
  // the file quadratic in the size of the graph it is writing.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Colour is resolved the same way the canvas resolves it, so a file opened
  // in Gephi matches what was on screen.
  const fillFor = (id: string): string => {
    const node = byId.get(id);
    if (!node) return NEUTRAL;
    if (node.color === null && style.nodeColor === "none") return palette.categorical[0];
    return markColor(node, graph.ranking, colors, palette);
  };

  // The label attribute carries the display name when one is mapped, which is
  // what Gephi shows; the id stays the id, so the endpoints still resolve.
  const labelColumn = styleColumn(style.nodeLabel);
  const labelled = labelColumn !== null && hasColumn(doc.nodes, labelColumn);

  const nodesEl = make("nodes");
  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id === null) continue;
    const element = make("node");
    element.setAttribute("id", id);
    element.setAttribute("label", labelled ? (cellToId(row[labelColumn]) ?? id) : id);

    const values = attValues(row, "node", nodeAttrs);
    if (values) element.appendChild(values);

    const node = byId.get(id);
    if (node) {
      const position = xml.createElementNS(VIZ_NS, "viz:position");
      position.setAttribute("x", String(Math.round((node.x ?? 0) * 100) / 100));
      // GEXF's y axis points up; SVG's points down.
      position.setAttribute("y", String(Math.round(-(node.y ?? 0) * 100) / 100));
      position.setAttribute("z", "0");
      element.appendChild(position);

      const size = xml.createElementNS(VIZ_NS, "viz:size");
      size.setAttribute("value", String(Math.round(node.radius * 100) / 100));
      element.appendChild(size);

      const { r, g, b } = rgbOf(fillFor(id));
      const color = xml.createElementNS(VIZ_NS, "viz:color");
      color.setAttribute("r", String(r));
      color.setAttribute("g", String(g));
      color.setAttribute("b", String(b));
      element.appendChild(color);
    }
    nodesEl.appendChild(element);
  }
  graphEl.appendChild(nodesEl);

  const edgesEl = make("edges");
  const widthColumn = styleColumn(style.edgeWidth);
  doc.edges.rows.forEach((row, i) => {
    const source = cellToId(row[doc.mapping.source]);
    const target = cellToId(row[doc.mapping.target]);
    if (source === null || target === null) return;
    const element = make("edge");
    element.setAttribute("id", `e${i}`);
    element.setAttribute("source", source);
    element.setAttribute("target", target);
    if (widthColumn !== null) {
      const weight = row[widthColumn];
      if (typeof weight === "number") element.setAttribute("weight", String(weight));
    }
    const values = attValues(row, "edge", edgeAttrs);
    if (values) element.appendChild(values);
    edgesEl.appendChild(element);
  });
  graphEl.appendChild(edgesEl);

  return serialize(xml);
}
