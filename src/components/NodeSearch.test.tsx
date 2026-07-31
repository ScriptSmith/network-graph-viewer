/**
 * @vitest-environment jsdom
 *
 * The find box: substring matches over labels and ids, a capped list, and a
 * pick that names the node's id whatever text the reader matched it by.
 */
import { expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyStyle, buildBaseGraph } from "../lib/graph";
import { DEFAULT_STYLE, type GraphDoc } from "../types";
import { NodeSearch } from "./NodeSearch";

const doc: GraphDoc = {
  name: "cast",
  edges: {
    name: "Edges",
    columns: [
      { name: "From", type: "text" },
      { name: "To", type: "text" },
    ],
    rows: [
      { From: "p1", To: "p2" },
      { From: "p2", To: "p3" },
    ],
  },
  nodes: {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Name", type: "text" },
    ],
    rows: [
      { Id: "p1", Name: "Grace Okafor" },
      { Id: "p2", Name: "Priya Sharma" },
      { Id: "p3", Name: "Kenji Mori" },
    ],
  },
  nodeIdColumn: "Id",
  mapping: { source: "From", target: "To", attrs: [] },
  nodesDeclared: true,
};

const graph = applyStyle(buildBaseGraph(doc), doc, {
  ...DEFAULT_STYLE,
  nodeLabel: "column:Name",
});

function mounted(onPick: (id: string) => void): { el: HTMLElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<NodeSearch graph={graph} corner="top-left" onPick={onPick} />);
  });
  return { el, root };
}

function type(el: HTMLElement, text: string): HTMLInputElement {
  const input = el.querySelector("input") as HTMLInputElement;
  act(() => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

test("matches labels and ids alike, and a pick answers with the id", () => {
  const picked: string[] = [];
  const { el, root } = mounted((id) => picked.push(id));

  type(el, "sharma");
  let options = [...el.querySelectorAll("[role=option]")];
  expect(options.map((o) => o.textContent)).toEqual(["Priya Sharmap2"]);

  act(() => {
    options[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(picked).toEqual(["p2"]);

  // The id is also a way in, and the pick still names the same node.
  type(el, "p3");
  options = [...el.querySelectorAll("[role=option]")];
  expect(options.map((o) => o.textContent)).toEqual(["Kenji Morip3"]);

  act(() => root.unmount());
});

test("enter picks the highlighted match", () => {
  const onPick = vi.fn();
  const { el, root } = mounted(onPick);

  const input = type(el, "ri");
  // "Priya Sharma" and "Kenji Mori" both contain "ri"; neither starts with it,
  // so the list keeps graph order and Enter takes the first.
  expect(el.querySelectorAll("[role=option]")).toHaveLength(2);
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onPick).toHaveBeenCalledWith("p2");

  act(() => root.unmount());
});

test("an empty query offers nothing rather than everything", () => {
  const { el, root } = mounted(() => {});
  type(el, "   ");
  expect(el.querySelector("[role=listbox]")).toBeNull();
  act(() => root.unmount());
});

test("clicking away clears the box, and the clear button does the same", () => {
  const { el, root } = mounted(() => {});
  const input = type(el, "sharma");

  // The clear button keeps focus for the next try.
  const clearButton = el.querySelector(".node-search-clear");
  expect(clearButton).not.toBeNull();
  act(() => {
    clearButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(input.value).toBe("");
  expect(el.querySelector(".node-search-clear")).toBeNull();

  // Clicking away lets go entirely.
  type(el, "mori");
  act(() => {
    input.blur();
    input.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
  });
  expect(input.value).toBe("");
  expect(el.querySelector("[role=listbox]")).toBeNull();

  act(() => root.unmount());
});

test("found nodes are remembered and offered again while the box is empty", () => {
  const picked: string[] = [];
  const { el, root } = mounted((id) => picked.push(id));

  type(el, "sharma");
  act(() => {
    el.querySelector("[role=option]")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
  });
  expect(picked).toEqual(["p2"]);

  // Focusing the empty box brings the find back, newest first.
  const input = el.querySelector("input") as HTMLInputElement;
  act(() => {
    input.focus();
    input.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
  });
  const options = [...el.querySelectorAll("[role=option]")];
  expect(options.map((o) => o.textContent)).toEqual(["Priya Sharmap2"]);
  expect(el.querySelector(".node-search-head")?.textContent).toBe("Recent");

  // Picking a remembered node works like any other pick.
  act(() => {
    options[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(picked).toEqual(["p2", "p2"]);

  act(() => root.unmount());
});
