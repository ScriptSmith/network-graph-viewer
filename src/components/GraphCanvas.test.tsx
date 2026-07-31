/**
 * @vitest-environment jsdom
 *
 * The canvas's one security-shaped promise: a node image column can name any
 * host on the web, and the graph carrying it can have arrived from a link
 * anyone could write, so nothing is fetched from the web until the reader says
 * so. Pictures that are already part of the graph, a data URI or inline SVG,
 * are unaffected, because drawing one asks nobody anything.
 */
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyStyle, buildBaseGraph } from "../lib/graph";
import { DEFAULT_STYLE, type BaseGraph, type GraphDoc, type GraphStyle } from "../types";
import { GRAPH_THEMES, groupColorMap } from "../theme";
import { GraphCanvas } from "./GraphCanvas";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  const svg = globalThis.SVGElement?.prototype as unknown as Record<string, unknown>;
  svg.getBBox ??= () => ({ x: 0, y: 0, width: 0, height: 0 });
  svg.getScreenCTM ??= () => null;
  svg.getComputedTextLength ??= () => 0;
  const root = globalThis.SVGSVGElement?.prototype as unknown as Record<string, unknown>;
  const length = { baseVal: { value: 0 } };
  root.width ??= length;
  root.height ??= length;
});

const REMOTE = "https://images.example/logo.png";
const LOCAL =
  "data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%201%201%22%3E%3C%2Fsvg%3E";

const doc: GraphDoc = {
  name: "pictures",
  edges: {
    name: "Edges",
    columns: [
      { name: "From", type: "text" },
      { name: "To", type: "text" },
    ],
    rows: [{ From: "a", To: "b" }],
  },
  nodes: {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Picture", type: "text" },
    ],
    rows: [
      { Id: "a", Picture: REMOTE },
      { Id: "b", Picture: LOCAL },
    ],
  },
  nodeIdColumn: "Id",
  mapping: { source: "From", target: "To", attrs: [] },
  nodesDeclared: true,
};

const base = buildBaseGraph(doc);
const graph = applyStyle(base, doc, { ...DEFAULT_STYLE, nodeImage: "column:Picture" });

/** Every source the canvas put in its defs, whether or not it loaded. */
function drawnSources(el: HTMLElement): string[] {
  return [...el.querySelectorAll("pattern image")].map((i) => i.getAttribute("href") ?? "");
}

function render(allowRemoteImages: boolean): { el: HTMLElement; probed: string[] } {
  const el = document.createElement("div");
  document.body.append(el);
  const probed: string[] = [];
  // The probe is the request: constructing an Image and setting src is what
  // actually reaches the network, so that is what has to be counted.
  vi.spyOn(window, "Image").mockImplementation(function (this: HTMLImageElement) {
    const image = document.createElement("img");
    Object.defineProperty(image, "src", { set: (v: string) => probed.push(v) });
    return image as unknown as HTMLImageElement;
  } as unknown as typeof Image);

  act(() => {
    createRoot(el).render(
      <GraphCanvas
        graph={graph}
        base={base}
        layout="force"
        layoutParams={{}}
        preventOverlap={false}
        labelMode="none"
        style={{ ...DEFAULT_STYLE, nodeImage: "column:Picture" }}
        colors={new Map()}
        edgeColors={new Map()}
        theme={GRAPH_THEMES.dark}
        attrColumns={[]}
        selection={null}
        onSelect={() => {}}
        allowRemoteImages={allowRemoteImages}
      />,
    );
  });
  return { el, probed };
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("a web address is neither drawn nor fetched until it is allowed", () => {
  const { el, probed } = render(false);
  expect(drawnSources(el)).not.toContain(REMOTE);
  expect(probed).not.toContain(REMOTE);
  expect(probed.some((p) => p.startsWith("http"))).toBe(false);
});

test("a picture already inside the graph draws without being allowed", () => {
  const { el } = render(false);
  expect(drawnSources(el)).toContain(LOCAL);
});

test("saying yes is what lets the request happen", () => {
  const { el, probed } = render(true);
  expect(drawnSources(el)).toContain(REMOTE);
  expect(probed).toContain(REMOTE);
});

/**
 * The structure/appearance split, from the outside: restyling repaints the
 * marks and leaves the simulation alone, where rebuilding would throw away the
 * positions and re-run the physics to arrive back where it started.
 */
const styleDoc: GraphDoc = {
  name: "styled",
  edges: {
    name: "Edges",
    columns: [
      { name: "From", type: "text" },
      { name: "To", type: "text" },
    ],
    rows: [
      { From: "a", To: "b" },
      { From: "b", To: "c" },
      { From: "c", To: "a" },
    ],
  },
  nodes: {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Team", type: "text" },
      { name: "Size", type: "number" },
    ],
    rows: [
      { Id: "a", Team: "red", Size: 1 },
      { Id: "b", Team: "blue", Size: 5 },
      { Id: "c", Team: "red", Size: 9 },
    ],
  },
  nodeIdColumn: "Id",
  mapping: { source: "From", target: "To", attrs: [] },
  nodesDeclared: true,
};

/** The object d3 has bound to a mark, which a rebuild would replace. */
const datumOf = (el: Element) => (el as unknown as { __data__: unknown }).__data__;

function renderStyled(el: HTMLElement, root: Root, style: GraphStyle, base: BaseGraph) {
  act(() => {
    root.render(
      <GraphCanvas
        graph={applyStyle(base, styleDoc, style)}
        base={base}
        layout="force"
        layoutParams={{}}
        preventOverlap={false}
        labelMode="none"
        style={style}
        colors={groupColorMap(["red", "blue"])}
        edgeColors={new Map()}
        theme={GRAPH_THEMES.dark}
        attrColumns={[]}
        selection={null}
        onSelect={() => {}}
      />,
    );
  });
  return [...el.querySelectorAll("[data-nodes] circle")];
}

test("restyling repaints the marks without rebuilding the scene", () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const base = buildBaseGraph(styleDoc);

  const plain = renderStyled(el, root, DEFAULT_STYLE, base);
  // Read before the next render: these arrays hold the same elements, and a
  // datum is read off the element, so comparing afterwards compares nothing.
  const before = plain.map((c) => c.getAttribute("fill"));
  const boundBefore = plain.map(datumOf);

  const coloured = renderStyled(el, root, { ...DEFAULT_STYLE, nodeColor: "column:Team" }, base);
  const after = coloured.map((c) => c.getAttribute("fill"));

  // Same elements, and same bound objects. A rebuild maps `graph.nodes` into
  // fresh nodes carrying x/y and rebinds them, so the datum surviving is what
  // says the simulation was left where it was.
  expect(coloured).toEqual(plain);
  expect(coloured.map(datumOf)).toEqual(boundBefore);
  expect(after).not.toEqual(before);
  // Two teams, so two colours, and the two reds agree.
  expect(new Set(after).size).toBe(2);
  expect(after[0]).toBe(after[2]);
});

test("resizing keeps the same marks and gives them their new radii", () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const base = buildBaseGraph(styleDoc);

  const uniform = renderStyled(el, root, { ...DEFAULT_STYLE, nodeSize: "metric:uniform" }, base);
  expect(new Set(uniform.map((c) => c.getAttribute("r"))).size).toBe(1);
  const boundBefore = uniform.map(datumOf);

  const sized = renderStyled(el, root, { ...DEFAULT_STYLE, nodeSize: "column:Size" }, base);
  expect(sized).toEqual(uniform);
  expect(sized.map(datumOf)).toEqual(boundBefore);
  const radii = sized.map((c) => Number(c.getAttribute("r")));
  expect(radii[0]).toBeLessThan(radii[2]);
});

test("a change to the network itself does rebuild, so the split is a real one", () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);

  const first = renderStyled(el, root, DEFAULT_STYLE, buildBaseGraph(styleDoc));
  expect(first).toHaveLength(3);
  const boundBefore = datumOf(first[0]);

  // A different network: same styling, one node and two edges fewer.
  const smaller: GraphDoc = {
    ...styleDoc,
    edges: { ...styleDoc.edges, rows: [{ From: "a", To: "b" }] },
    nodes: { ...styleDoc.nodes, rows: styleDoc.nodes.rows.slice(0, 2) },
  };
  const second = renderStyled(el, root, DEFAULT_STYLE, buildBaseGraph(smaller));

  expect(second).toHaveLength(2);
  // Rebound, not merely repainted.
  expect(datumOf(second[0])).not.toBe(boundBefore);
});

/**
 * Reaching the graph without a mouse. The canvas is the app's whole point and
 * selecting a node is the widget's entire Python surface, so a mouse-only
 * canvas is not a rough edge, it is a locked door (WCAG 2.1.1).
 */
function renderKeyboard(): { el: HTMLElement; selected: (string | null)[] } {
  const el = document.createElement("div");
  document.body.append(el);
  const selected: (string | null)[] = [];
  const base = buildBaseGraph(styleDoc);
  act(() => {
    createRoot(el).render(
      <GraphCanvas
        graph={applyStyle(base, styleDoc, DEFAULT_STYLE)}
        base={base}
        layout="force"
        layoutParams={{}}
        preventOverlap={false}
        labelMode="none"
        style={DEFAULT_STYLE}
        colors={new Map()}
        edgeColors={new Map()}
        theme={GRAPH_THEMES.dark}
        attrColumns={[]}
        selection={null}
        onSelect={(next) => selected.push(next === null ? null : (next as { id: string }).id)}
      />,
    );
  });
  return { el, selected };
}

const circles = (el: HTMLElement) => [
  ...el.querySelectorAll<SVGCircleElement>("[data-nodes] circle"),
];
const focusedId = () => document.activeElement?.getAttribute("data-id") ?? null;
const press = (key: string) =>
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

test("exactly one node is in the tab order, whatever the size of the graph", () => {
  const { el } = renderKeyboard();
  const tabbable = circles(el).filter((c) => c.getAttribute("tabindex") !== null);
  expect(tabbable).toHaveLength(1);
  // The most connected node, so tabbing in arrives somewhere worth being.
  expect(tabbable[0].getAttribute("data-id")).toBe("a");
});

test("every node carries a name worth reading out", () => {
  const { el } = renderKeyboard();
  const labels = circles(el).map((c) => c.getAttribute("aria-label"));
  expect(labels[0]).toMatch(/^a, /);
  expect(labels[0]).toContain("1 in, 1 out");
  expect(labels[0]).toContain("2 neighbours");
});

test("left and right walk every node, most connected first", () => {
  const { el } = renderKeyboard();
  act(() =>
    circles(el)
      .find((c) => c.getAttribute("tabindex") !== null)
      ?.focus(),
  );
  expect(focusedId()).toBe("a");

  press("ArrowRight");
  const second = focusedId();
  press("ArrowRight");
  const third = focusedId();
  expect(new Set(["a", second, third]).size).toBe(3);

  // And it wraps, so the tour has no dead end.
  press("ArrowRight");
  expect(focusedId()).toBe("a");
  press("ArrowLeft");
  expect(focusedId()).toBe(third);
});

test("up and down walk the neighbours of wherever you are", () => {
  const { el } = renderKeyboard();
  act(() =>
    circles(el)
      .find((c) => c.getAttribute("tabindex") !== null)
      ?.focus(),
  );
  press("ArrowDown");
  // A triangle, so every neighbour step lands on a real neighbour.
  expect(["b", "c"]).toContain(focusedId());
});

test("Enter selects the focused node and Escape clears it", () => {
  const { el, selected } = renderKeyboard();
  act(() =>
    circles(el)
      .find((c) => c.getAttribute("tabindex") !== null)
      ?.focus(),
  );
  press("Enter");
  expect(selected).toEqual(["a"]);
  press("Escape");
  expect(selected).toEqual(["a", null]);
});

test("moving focus moves the tab order with it", () => {
  const { el } = renderKeyboard();
  act(() =>
    circles(el)
      .find((c) => c.getAttribute("tabindex") !== null)
      ?.focus(),
  );
  press("ArrowRight");
  const tabbable = circles(el).filter((c) => c.getAttribute("tabindex") !== null);
  expect(tabbable).toHaveLength(1);
  expect(tabbable[0].getAttribute("data-id")).toBe(focusedId());
});

test("focus says where it is, for whoever is listening rather than looking", () => {
  const { el } = renderKeyboard();
  act(() =>
    circles(el)
      .find((c) => c.getAttribute("tabindex") !== null)
      ?.focus(),
  );
  const live = el.querySelector('[aria-live="polite"]');
  expect(live?.textContent).toMatch(/^a, /);
  press("ArrowRight");
  expect(live?.textContent).not.toMatch(/^a, /);
});

test("the decorative canvas is not in the tab order at all", () => {
  const el = document.createElement("div");
  document.body.append(el);
  const base = buildBaseGraph(styleDoc);
  act(() => {
    createRoot(el).render(
      <GraphCanvas
        graph={applyStyle(base, styleDoc, DEFAULT_STYLE)}
        base={base}
        layout="force"
        layoutParams={{}}
        preventOverlap={false}
        labelMode="none"
        style={DEFAULT_STYLE}
        colors={new Map()}
        edgeColors={new Map()}
        theme={GRAPH_THEMES.dark}
        attrColumns={[]}
        selection={null}
        onSelect={() => {}}
        ambient
      />,
    );
  });
  expect(circles(el).some((c) => c.getAttribute("tabindex") !== null)).toBe(false);
  expect(el.querySelector("svg")?.getAttribute("role")).toBe("img");
  expect(el.querySelector('[aria-live="polite"]')).toBeNull();
});

/**
 * Reduced motion. The layout still runs, because the layout is the answer; what
 * goes is watching it arrive, which is the decoration.
 */
test("with reduced motion the layout is already arranged on the first paint", () => {
  const reduce = (matches: boolean) =>
    ((query: string) =>
      ({
        matches: matches && query.includes("reduced-motion"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;

  const render = () => {
    const el = document.createElement("div");
    document.body.append(el);
    const base = buildBaseGraph(styleDoc);
    act(() => {
      createRoot(el).render(
        <GraphCanvas
          graph={applyStyle(base, styleDoc, DEFAULT_STYLE)}
          base={base}
          layout="force"
          layoutParams={{}}
          preventOverlap={false}
          labelMode="none"
          style={DEFAULT_STYLE}
          colors={new Map()}
          edgeColors={new Map()}
          theme={GRAPH_THEMES.dark}
          attrColumns={[]}
          selection={null}
          onSelect={() => {}}
        />,
      );
    });
    return circles(el).map((c) => Number(c.getAttribute("cx")));
  };

  const original = window.matchMedia;
  try {
    window.matchMedia = reduce(true);
    const settled = render();
    // Positions are on the marks before a single frame has been asked for.
    expect(settled.every((x) => Number.isFinite(x))).toBe(true);
    // A settled force layout has spread the nodes out; the seeding spiral
    // would have left them within a few tens of units of each other.
    expect(Math.max(...settled) - Math.min(...settled)).toBeGreaterThan(20);
  } finally {
    window.matchMedia = original;
  }
});
