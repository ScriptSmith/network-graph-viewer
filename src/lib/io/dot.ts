import type { Column, Graph, GraphDoc, GraphStyle, Row } from "../../types";
import { styleColumn } from "../../types";
import { cellToId } from "../cells";
import { DEFAULT_NODE_ID_COLUMN, hasColumn } from "../doc";
import { DEFAULT_COLORS, type Palette } from "../../theme";
import { markColor } from "../graph";
import { inferColumns } from "../parse";
import { cellToText, coerce, tableFrom, uniqueName } from "./xml";
import type { ImportedGraph, Position } from "./types";

/**
 * Graphviz's DOT. The one graph format here that is not XML and not a table,
 * so it carries its own lexer and a recursive-descent parser for the grammar
 * at graphviz.org/doc/info/lang.html.
 *
 * DOT says less about data than GEXF and GraphML do: attributes are declared
 * nowhere and every value arrives as a string, so column types are inferred
 * from the values the way a CSV's are. Everything the language does that our
 * two tables cannot hold is flattened: an edge chain becomes its pairs, an
 * edge between subgraphs becomes the product of their nodes, and the `node`
 * and `edge` default blocks are folded into the rows they were standing in
 * front of. What survives the flattening is clusters, which are a grouping
 * rather than a shared setting, so they come through as a node column.
 */

const CLUSTER_COLUMN = "Cluster";

/**
 * Geometry Graphviz writes back into a file it has already laid out. `pos`
 * becomes positions rather than a column; the rest is a drawing, not data.
 */
const INTERNAL_ATTRS = /^(pos|lp|_[a-z]*draw_)$/i;

/** Words the language keeps for itself, which is why the writer quotes them. */
const RESERVED = new Set(["node", "edge", "graph", "digraph", "subgraph", "strict"]);

// -- Reading ---------------------------------------------------------------

type TokenKind = "id" | "punct" | "edge" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  /** Quoted and HTML names are values, whatever they happen to spell. */
  quoted: boolean;
}

const PUNCT = "{}[];,=:";
const NUMERAL = /-?(?:\.\d+|\d+(?:\.\d*)?)/y;
// A `#` is only a comment at the start of a line, so it is a name character
// everywhere else: files written by hand say `color=#ff0000` without quotes.
const NAME = /[A-Za-z_#\u0080-\uFFFF][\w#\u0080-\uFFFF]*/y;

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

/** An HTML-like label as the text it shows: the app has nowhere to put markup. */
function plainText(markup: string): string {
  return markup
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(\w+);/g, (whole, name: string) => ENTITIES.get(name.toLowerCase()) ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, value: string, quoted = false) =>
    tokens.push({ kind, value, quoted });

  const atLineStart = (from: number): boolean => {
    for (let i = from - 1; i >= 0; i--) {
      const c = text[i];
      if (c === "\n") return true;
      if (c !== " " && c !== "\t" && c !== "\r") return false;
    }
    return true;
  };

  /** Past whitespace and comments, in whatever order they are stacked. */
  const trivia = (from: number): number => {
    let i = from;
    for (;;) {
      const before = i;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i) || (text[i] === "#" && atLineStart(i))) {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        i = end === -1 ? text.length : end + 2;
      }
      if (i === before) return i;
    }
  };

  /** A quoted name, and where it ends. Graphviz joins `"a" + "b"` into one. */
  const readQuoted = (from: number): [string, number] => {
    let i = from;
    let out = "";
    for (;;) {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] !== "\\") {
          out += text[i];
          i++;
          continue;
        }
        const escaped = text[i + 1];
        // A backslash before a newline continues the line; \n, \l and \r are
        // the language's line breaks and read as one here. Anything else is
        // left as written, since \N and its kin are for Graphviz to expand.
        if (escaped === "\n") i += 2;
        else if (escaped === '"' || escaped === "\\") {
          out += escaped;
          i += 2;
        } else if (escaped === "n" || escaped === "l" || escaped === "r") {
          out += "\n";
          i += 2;
        } else {
          out += text[i];
          i++;
        }
      }
      if (i >= text.length)
        throw new Error("That DOT file has a quoted name that is never closed.");
      i++;
      const plus = trivia(i);
      if (text[plus] !== "+") return [out, i];
      const next = trivia(plus + 1);
      if (text[next] !== '"') return [out, i];
      i = next;
    }
  };

  /** An HTML name, which ends at the `>` that balances its `<`. */
  const readHtml = (from: number): [string, number] => {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      if (text[i] === "<") depth++;
      else if (text[i] === ">" && --depth === 0) {
        i++;
        break;
      }
      i++;
    }
    if (depth !== 0) throw new Error("That DOT file has an HTML name that is never closed.");
    return [plainText(text.slice(from + 1, i - 1)), i];
  };

  let at = 0;
  while ((at = trivia(at)) < text.length) {
    const c = text[at];
    if (c === '"') {
      const [value, end] = readQuoted(at);
      push("id", value, true);
      at = end;
    } else if (c === "<") {
      const [value, end] = readHtml(at);
      push("id", value, true);
      at = end;
    } else if (c === "-" && (text[at + 1] === "-" || text[at + 1] === ">")) {
      push("edge", text.slice(at, at + 2));
      at += 2;
    } else if (PUNCT.includes(c)) {
      push("punct", c);
      at++;
    } else {
      NUMERAL.lastIndex = at;
      NAME.lastIndex = at;
      const match = NUMERAL.exec(text) ?? NAME.exec(text);
      if (!match) throw new Error(`That DOT file has an unexpected "${c}" in it.`);
      push("id", match[0]);
      at += match[0].length;
    }
  }
  push("eof", "");
  return tokens;
}

/** A node as the file declares it: its attributes, and the cluster it sits in. */
interface RawNode {
  attrs: Record<string, string>;
  cluster: string | null;
}

interface RawEdge {
  source: string;
  target: string;
  attrs: Record<string, string>;
}

interface DotSource {
  directed: boolean;
  /** Every node named anywhere, in the order the file first names it. */
  nodes: Map<string, RawNode>;
  edges: RawEdge[];
}

/**
 * The defaults in force at a point in the file. A subgraph starts from a copy
 * of its parent's, so what it sets stays inside it, which is what `node` and
 * `edge` blocks are for.
 */
interface Scope {
  node: Record<string, string>;
  edge: Record<string, string>;
  /** What this subgraph calls itself, once it has said so. */
  label: string | null;
}

const record = (from?: Record<string, string>): Record<string, string> =>
  Object.assign(Object.create(null) as Record<string, string>, from);

function readDot(text: string): DotSource {
  const tokens = tokenize(text);
  let at = 0;

  // Both stop at the end-of-file token rather than running off the array: a
  // truncated file should reach an error message, not a missing property.
  const peek = (ahead = 0) => tokens[Math.min(at + ahead, tokens.length - 1)];
  const take = () => {
    const token = peek();
    at = Math.min(at + 1, tokens.length);
    return token;
  };
  const punct = (token: Token, value: string) => token.kind === "punct" && token.value === value;
  const keyword = (token: Token, word: string) =>
    token.kind === "id" && !token.quoted && token.value.toLowerCase() === word;
  const expect = (value: string) => {
    if (!punct(peek(), value)) throw new Error(`That DOT file is missing a "${value}".`);
    take();
  };

  const nodes = new Map<string, RawNode>();
  const edges: RawEdge[] = [];

  /**
   * A node, created if this is the first time the file has named it. The
   * defaults it keeps are the ones in force here: a later `node` block is for
   * the nodes after it, not the ones already declared.
   */
  const touch = (id: string, scope: Scope): string => {
    if (!nodes.has(id)) nodes.set(id, { attrs: record(scope.node), cluster: null });
    return id;
  };

  const attrList = (): Record<string, string> => {
    const attrs = record();
    while (punct(peek(), "[")) {
      take();
      while (!punct(peek(), "]")) {
        const token = take();
        if (token.kind === "eof") {
          throw new Error("That DOT file has an attribute list that is never closed.");
        }
        if (punct(token, ",") || punct(token, ";")) continue;
        if (token.kind !== "id") {
          throw new Error(`That DOT file has "${token.value}" where an attribute name should be.`);
        }
        if (!punct(peek(), "=")) {
          attrs[token.value] = "true";
          continue;
        }
        take();
        const value = take();
        if (value.kind !== "id") {
          throw new Error(`That DOT file gives the attribute "${token.value}" no value.`);
        }
        attrs[token.value] = value.value;
      }
      take();
    }
    return attrs;
  };

  /** A node's name, and its port, which is about a drawing rather than a graph. */
  const nodeName = (): string => {
    const token = take();
    if (token.kind !== "id") {
      throw new Error(`That DOT file has "${token.value || "its end"}" where a name should be.`);
    }
    while (punct(peek(), ":") && peek(1).kind === "id") {
      take();
      take();
    }
    return token.value;
  };

  // Mutually recursive: a statement can be a subgraph, and a subgraph is a
  // list of statements. Declarations rather than consts so the order they are
  // written in doesn't have to be a topological sort.

  function endpoint(scope: Scope): string[] {
    if (keyword(peek(), "subgraph") || punct(peek(), "{")) return subgraph(scope);
    return [touch(nodeName(), scope)];
  }

  /**
   * The rest of an edge statement, once its left-hand side is in hand. A chain
   * `a -> b -> c` is its consecutive pairs, and an endpoint that is a subgraph
   * stands for every node in it, so the pair becomes a product.
   */
  function edgeTail(from: string[], scope: Scope): string[] {
    const pairs: [string[], string[]][] = [];
    const touched = [...from];
    let left = from;
    while (peek().kind === "edge") {
      take();
      const right = endpoint(scope);
      pairs.push([left, right]);
      touched.push(...right);
      left = right;
    }
    if (pairs.length === 0) return touched;
    const attrs = attrList();
    for (const [heads, tails] of pairs) {
      for (const head of heads) {
        for (const tail of tails) {
          edges.push({ source: head, target: tail, attrs: record({ ...scope.edge, ...attrs }) });
        }
      }
    }
    return touched;
  }

  function statement(scope: Scope): string[] {
    const token = peek();

    // `node [...]`, `edge [...]` and `graph [...]`: defaults for this scope.
    const block =
      keyword(token, "node") || keyword(token, "edge") || keyword(token, "graph")
        ? token.value.toLowerCase()
        : null;
    if (block !== null && punct(peek(1), "[")) {
      take();
      const attrs = attrList();
      if (block === "node") Object.assign(scope.node, attrs);
      else if (block === "edge") Object.assign(scope.edge, attrs);
      else if (typeof attrs.label === "string") scope.label = attrs.label;
      return [];
    }

    if (keyword(token, "subgraph") || punct(token, "{")) return edgeTail(subgraph(scope), scope);

    // `name = value`, one of the drawing's own settings. Only a subgraph's
    // label is any use here, and only as what to call the cluster.
    if (token.kind === "id" && punct(peek(1), "=")) {
      take();
      take();
      const value = take();
      if (value.kind === "id" && token.value.toLowerCase() === "label") scope.label = value.value;
      return [];
    }

    const id = nodeName();
    if (peek().kind === "edge") return edgeTail([touch(id, scope)], scope);
    const attrs = attrList();
    touch(id, scope);
    // A node named twice collects what both statements said about it.
    Object.assign((nodes.get(id) as RawNode).attrs, attrs);
    return [id];
  }

  function statements(scope: Scope): string[] {
    const touched: string[] = [];
    for (;;) {
      const token = peek();
      if (token.kind === "eof" || punct(token, "}")) return touched;
      if (punct(token, ";")) {
        take();
        continue;
      }
      touched.push(...statement(scope));
    }
  }

  function subgraph(scope: Scope): string[] {
    let name: string | null = null;
    if (keyword(peek(), "subgraph")) {
      take();
      if (peek().kind === "id") name = take().value;
    }
    expect("{");
    const inner: Scope = { node: record(scope.node), edge: record(scope.edge), label: null };
    const members = statements(inner);
    expect("}");

    // Graphviz draws a box around a subgraph whose name starts with "cluster",
    // and only that one, so it is the only one that means a grouping rather
    // than a set of shared settings. A nested cluster has already claimed its
    // own nodes by the time the one around it gets to ask.
    if (name !== null && /^cluster/i.test(name)) {
      const trimmed = inner.label ?? name.replace(/^cluster[_\-.]?/i, "");
      const cluster = trimmed.trim() === "" ? name : trimmed;
      for (const id of members) {
        const node = nodes.get(id);
        if (node && node.cluster === null) node.cluster = cluster;
      }
    }
    return [...new Set(members)];
  }

  if (keyword(peek(), "strict")) take();
  const kind = take();
  const directed = keyword(kind, "digraph");
  if (!directed && !keyword(kind, "graph")) {
    throw new Error('That DOT file does not start with "graph" or "digraph".');
  }
  if (peek().kind === "id") take();
  expect("{");
  statements({ node: record(), edge: record(), label: null });
  expect("}");

  return { directed, nodes, edges };
}

/** A `pos` attribute as a point, dropping the `!` that pins one in place. */
function positionFrom(raw: string | undefined): Position | null {
  if (raw === undefined) return null;
  const [x, y] = raw.replace(/!$/, "").split(",").map(Number);
  // Graphviz's y axis points up; SVG's points down.
  return isFinite(x) && isFinite(y) ? { x, y: -y } : null;
}

/**
 * Type the columns from what their values look like, then coerce the cells to
 * match. DOT declares nothing, so every value arrives here as a string.
 */
function typedColumns(rows: Row[], names: string[]): Column[] {
  const columns = inferColumns(rows, names);
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column.name];
      if (typeof value === "string") row[column.name] = coerce(value, column.type);
    }
  }
  return columns;
}

export function parseDot(text: string, name: string): ImportedGraph {
  const source = readDot(text);
  const entries = [...source.nodes.entries()];

  const nodeTaken = new Set<string>([DEFAULT_NODE_ID_COLUMN]);
  const edgeTaken = new Set<string>(["Source", "Target"]);

  /** Every attribute name used, in the order the file first uses it. */
  const attrNames = (records: Record<string, string>[]): string[] => {
    const names = new Set<string>();
    for (const attrs of records) {
      for (const key of Object.keys(attrs)) if (!INTERNAL_ATTRS.test(key)) names.add(key);
    }
    return [...names];
  };

  // A GEXF or GraphML label becomes the node id when every node has a distinct
  // one, because ids in those are so often counters. A DOT id is written by
  // hand and read by people, and its label is as likely to be a record's field
  // layout as a name, so here the id stays the id and the label is a column
  // the display name is pointed at.
  const nodeColumnFor = new Map(
    attrNames(entries.map(([, node]) => node.attrs)).map((key) => [
      key,
      uniqueName(nodeTaken, key),
    ]),
  );
  const labelColumn = entries.some(([, node]) => (node.attrs.label ?? "") !== "")
    ? (nodeColumnFor.get("label") ?? null)
    : null;
  const clustered = entries.some(([, node]) => node.cluster !== null);
  const clusterColumn = clustered ? uniqueName(nodeTaken, CLUSTER_COLUMN) : null;

  const positions = new Map<string, Position>();
  const nodeRows: Row[] = entries.map(([id, node]) => {
    const row: Row = { [DEFAULT_NODE_ID_COLUMN]: id };
    for (const [key, column] of nodeColumnFor) row[column] = node.attrs[key] ?? null;
    if (clusterColumn !== null) row[clusterColumn] = node.cluster;
    const position = positionFrom(node.attrs.pos);
    if (position !== null) positions.set(id, position);
    return row;
  });

  const edgeColumnFor = new Map(
    attrNames(source.edges.map((edge) => edge.attrs)).map((key) => [
      key,
      uniqueName(edgeTaken, key),
    ]),
  );
  const edgeRows: Row[] = source.edges.map((edge) => {
    const row: Row = { Source: edge.source, Target: edge.target };
    for (const [key, column] of edgeColumnFor) row[column] = edge.attrs[key] ?? null;
    return row;
  });

  const nodeColumns: Column[] = [
    { name: DEFAULT_NODE_ID_COLUMN, type: "text" },
    ...typedColumns(nodeRows, [
      ...nodeColumnFor.values(),
      ...(clusterColumn === null ? [] : [clusterColumn]),
    ]),
  ];
  const edgeColumns: Column[] = [
    { name: "Source", type: "text" },
    { name: "Target", type: "text" },
    ...typedColumns(edgeRows, [...edgeColumnFor.values()]),
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

  // A plain `graph` is undirected, and an arrowhead on an undirected edge says
  // something the file did not.
  const stated: Partial<GraphStyle> = {
    ...(source.directed ? {} : { arrows: false }),
    ...(labelColumn === null ? {} : { nodeLabel: `column:${labelColumn}` }),
  };

  return {
    doc,
    positions: positions.size > 0 ? positions : undefined,
    style: Object.keys(stated).length > 0 ? stated : undefined,
  };
}

// -- Writing ---------------------------------------------------------------

/** Graphviz sizes nodes in inches and places them in points. */
const POINTS_PER_INCH = 72;

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name or a value as DOT will read it back: bare when it can be, quoted when not. */
function dotId(value: string): string {
  if (PLAIN_NAME.test(value) && !RESERVED.has(value.toLowerCase())) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

const round = (value: number, places = 2): string =>
  String(Math.round(value * 10 ** places) / 10 ** places);

export interface DotExportOptions {
  doc: GraphDoc;
  /** The styled graph, which supplies positions, radii and colours. */
  graph: Graph;
  style: GraphStyle;
  /** The palette in force; defaults to the shipped one. */
  palette?: Palette;
  colors: Map<string, string>;
}

/**
 * Write the graph as DOT. Sizes and colours go in alongside the data, and so
 * do positions when the graph has any: neato is named as the engine because it
 * is the one that honours a pinned position, and every node is pinned, so the
 * file renders as what was on screen rather than being laid out from nothing.
 *
 * A graph with no coordinates on it says nothing about where anything goes and
 * leaves the engine unnamed, since a `pos` defaulted to the origin would pin
 * the whole network into one pile.
 *
 * Attributes are collected into a map keyed by name, with what the style says
 * written last, so a column that happens to be called `color` is stated once
 * and says what the graph is actually showing.
 */
export function writeDot({
  doc,
  graph,
  style,
  palette = DEFAULT_COLORS,
  colors,
}: DotExportOptions): string {
  const directed = style.arrows;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const nodeAttrs = doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn);
  const edgeAttrs = doc.edges.columns.filter(
    (c) => c.name !== doc.mapping.source && c.name !== doc.mapping.target,
  );

  const labelColumn = styleColumn(style.nodeLabel);
  const labelled = labelColumn !== null && hasColumn(doc.nodes, labelColumn);
  const widthColumn = styleColumn(style.edgeWidth);

  const dataAttrs = (row: Row, columns: Column[]): Map<string, string> => {
    const attrs = new Map<string, string>();
    for (const column of columns) {
      const value = row[column.name];
      if (value === null || value === undefined || value === "") continue;
      attrs.set(column.name, cellToText(value));
    }
    return attrs;
  };

  const written = (attrs: Map<string, string>): string => {
    if (attrs.size === 0) return "";
    const pairs = [...attrs].map(([key, value]) => `${dotId(key)}=${dotId(value)}`);
    return ` [${pairs.join(", ")}]`;
  };

  const placed = graph.nodes.some((node) => node.x !== undefined && node.y !== undefined);

  const lines: string[] = [];
  lines.push(`${directed ? "digraph" : "graph"} ${dotId(doc.name || "G")} {`);
  if (placed) lines.push(`  graph [layout="neato", overlap="true"];`);
  lines.push(`  node [shape="circle", style="filled", fixedsize="true"];`);

  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id === null) continue;
    const attrs = dataAttrs(row, nodeAttrs);
    attrs.set("label", labelled ? (cellToId(row[labelColumn]) ?? id) : id);

    const node = byId.get(id);
    if (node) {
      const fill = markColor(node, graph.ranking, colors, palette);
      attrs.set("color", fill);
      attrs.set("fillcolor", fill);
      const inches = round((node.radius * 2) / POINTS_PER_INCH);
      attrs.set("width", inches);
      attrs.set("height", inches);
      if (placed && node.x !== undefined && node.y !== undefined) {
        // Pinned, and with the y axis flipped: Graphviz's points up.
        attrs.set("pos", `${round(node.x)},${round(-node.y)}!`);
      }
    }
    lines.push(`  ${dotId(id)}${written(attrs)};`);
  }

  const arrow = directed ? "->" : "--";
  for (const row of doc.edges.rows) {
    const source = cellToId(row[doc.mapping.source]);
    const target = cellToId(row[doc.mapping.target]);
    if (source === null || target === null) continue;
    const attrs = dataAttrs(row, edgeAttrs);
    if (widthColumn !== null && typeof row[widthColumn] === "number") {
      attrs.set("weight", String(row[widthColumn]));
    }
    lines.push(`  ${dotId(source)} ${arrow} ${dotId(target)}${written(attrs)};`);
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}
