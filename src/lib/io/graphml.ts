import type { Column, GraphDoc, Row } from "../../types";
import { cellToId } from "../cells";
import { DEFAULT_NODE_ID_COLUMN } from "../doc";
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
 * GraphML. Attributes are declared up front as `<key>` elements and referenced
 * by id from `<data>`, so reading is a two-pass job: collect the keys, then
 * walk the nodes and edges. There is no label convention in the spec, so a key
 * called label or name is treated as the node's display id when present.
 */

const GRAPHML_NS = "http://graphml.graphdrawing.org/xmlns";
const LABEL_KEYS = /^(label|name|title)$/i;

interface KeyDef {
  column: Column;
  scope: "node" | "edge";
  isLabel: boolean;
  default: string | null;
}

export function parseGraphml(text: string, name: string): ImportedGraph {
  const xml = parseXml(text, "GraphML");
  const graph = xml.querySelector("graph");
  if (!graph) throw new Error("That GraphML file has no <graph> element.");

  const nodeTaken = new Set<string>([DEFAULT_NODE_ID_COLUMN]);
  const edgeTaken = new Set<string>(["Source", "Target"]);
  const keys = new Map<string, KeyDef>();

  for (const key of xml.querySelectorAll("key")) {
    const id = key.getAttribute("id");
    if (id === null) continue;
    const scope = key.getAttribute("for") === "edge" ? "edge" : "node";
    const title = key.getAttribute("attr.name") ?? id;
    const isLabel = scope === "node" && LABEL_KEYS.test(title);
    keys.set(id, {
      scope,
      isLabel,
      default: key.querySelector("default")?.textContent ?? null,
      column: {
        name: uniqueName(scope === "node" ? nodeTaken : edgeTaken, title),
        type: columnTypeFrom(key.getAttribute("attr.type")),
      },
    });
  }

  const labelKey = [...keys.values()].find((k) => k.isLabel) ?? null;

  const readData = (element: Element, row: Row, scope: "node" | "edge"): void => {
    for (const key of keys.values()) {
      if (key.scope !== scope || key.default === null) continue;
      row[key.column.name] = coerce(key.default, key.column.type);
    }
    for (const data of element.querySelectorAll(":scope > data")) {
      const key = keys.get(data.getAttribute("key") ?? "");
      if (!key || key.scope !== scope) continue;
      row[key.column.name] = coerce(data.textContent?.trim() ?? "", key.column.type);
    }
  };

  const elements = [...graph.querySelectorAll("node")];
  const rawIds = elements.map((n) => n.getAttribute("id") ?? "");
  const staged = elements.map((element, i) => {
    const row: Row = {};
    readData(element, row, "node");
    return { row, rawId: rawIds[i] };
  });

  // Use the label key as the node id when it is complete and unambiguous.
  const labels = labelKey ? staged.map((s) => cellToText(s.row[labelKey.column.name] ?? null)) : [];
  const useLabels =
    labelKey !== null &&
    labels.length > 0 &&
    labels.every((l) => l.trim() !== "") &&
    new Set(labels).size === labels.length;

  const nameOf = new Map<string, string>();
  staged.forEach((s, i) => nameOf.set(s.rawId, useLabels ? labels[i] : s.rawId));

  const nodeRows: Row[] = staged.map((s, i) => ({
    ...s.row,
    [DEFAULT_NODE_ID_COLUMN]: nameOf.get(s.rawId) ?? rawIds[i],
  }));

  const edgeRows: Row[] = [];
  for (const element of graph.querySelectorAll("edge")) {
    const source = nameOf.get(element.getAttribute("source") ?? "");
    const target = nameOf.get(element.getAttribute("target") ?? "");
    if (source === undefined || target === undefined) continue;
    const row: Row = { Source: source, Target: target };
    readData(element, row, "edge");
    edgeRows.push(row);
  }

  const nodeColumns: Column[] = [
    { name: DEFAULT_NODE_ID_COLUMN, type: "text" },
    ...[...keys.values()]
      .filter((k) => k.scope === "node" && !(useLabels && k.isLabel))
      .map((k) => k.column),
  ];
  const edgeColumns: Column[] = [
    { name: "Source", type: "text" },
    { name: "Target", type: "text" },
    ...[...keys.values()].filter((k) => k.scope === "edge").map((k) => k.column),
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
  return { doc };
}

export function writeGraphml(doc: GraphDoc): string {
  // The root already carries the GraphML namespace from createDocument, and
  // every child has to be created in it too or it serializes as xmlns="".
  const xml = document.implementation.createDocument(GRAPHML_NS, "graphml", null);
  const root = xml.documentElement;
  const make = (name: string) => xml.createElementNS(GRAPHML_NS, name);

  const nodeAttrs = doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn);
  const edgeAttrs = doc.edges.columns.filter(
    (c) => c.name !== doc.mapping.source && c.name !== doc.mapping.target,
  );

  const keyId = new Map<string, string>();
  const declare = (scope: "node" | "edge", columns: Column[]) => {
    columns.forEach((column, i) => {
      const id = `${scope[0]}${i}`;
      keyId.set(`${scope}:${column.name}`, id);
      const key = make("key");
      key.setAttribute("id", id);
      key.setAttribute("for", scope);
      key.setAttribute("attr.name", column.name);
      key.setAttribute("attr.type", declaredTypeFor(column.type));
      root.appendChild(key);
    });
  };
  declare("node", nodeAttrs);
  declare("edge", edgeAttrs);

  const graph = make("graph");
  graph.setAttribute("id", doc.name || "G");
  graph.setAttribute("edgedefault", "directed");
  root.appendChild(graph);

  const writeData = (parent: Element, row: Row, scope: "node" | "edge", columns: Column[]) => {
    for (const column of columns) {
      const value = row[column.name];
      if (value === null || value === undefined || value === "") continue;
      const data = make("data");
      data.setAttribute("key", keyId.get(`${scope}:${column.name}`) as string);
      data.textContent = cellToText(value);
      parent.appendChild(data);
    }
  };

  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id === null) continue;
    const element = make("node");
    element.setAttribute("id", id);
    writeData(element, row, "node", nodeAttrs);
    graph.appendChild(element);
  }

  doc.edges.rows.forEach((row, i) => {
    const source = cellToId(row[doc.mapping.source]);
    const target = cellToId(row[doc.mapping.target]);
    if (source === null || target === null) return;
    const element = make("edge");
    element.setAttribute("id", `e${i}`);
    element.setAttribute("source", source);
    element.setAttribute("target", target);
    writeData(element, row, "edge", edgeAttrs);
    graph.appendChild(element);
  });

  return serialize(xml);
}
