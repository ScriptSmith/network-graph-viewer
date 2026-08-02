/**
 * @vitest-environment jsdom
 *
 * The embed's own contract, not the app's: that mounting puts a whole app in a
 * shadow root the host cannot see into, that a workspace handed in is the
 * graph that opens, and that destroying gives the element back empty. The
 * graph itself is `graph.test.ts`'s business.
 */
import { beforeAll, expect, test } from "vitest";
import { act } from "react";
import fixture from "../python/tests/fixtures/workspace.json?raw";
import { mount } from "./embed";

// jsdom implements neither, and the canvas asks for both the moment it draws.
// Enough of each to get past the mount; measuring is a browser's job.
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
  // d3-zoom reads these off the root element to work out its extent.
  const root = globalThis.SVGSVGElement?.prototype as unknown as Record<string, unknown>;
  const length = { baseVal: { value: 0 } };
  root.width ??= length;
  root.height ??= length;
});

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

test("mounts into a shadow root rather than into the host's page", async () => {
  const el = host();
  let handle!: ReturnType<typeof mount>;
  await act(async () => {
    handle = mount(el);
  });

  expect(el.shadowRoot).not.toBeNull();
  // The host's own tree stays empty: everything is behind the boundary.
  expect(el.children).toHaveLength(0);
  expect(el.shadowRoot?.querySelector(".app")).not.toBeNull();
  // The stylesheet travels with it, since a shadow root inherits none.
  expect(el.shadowRoot?.querySelector("style")?.textContent).toContain(".app");

  await act(async () => handle.destroy());
  expect(el.shadowRoot?.childNodes).toHaveLength(0);
});

test("opens the workspace it is handed", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture });
  });

  const text = el.shadowRoot?.textContent ?? "";
  // The fixture's own nodes, its columns and the groups its colour column
  // produced: the graph came in, and the styling came with it.
  expect(text).toContain("ana");
  expect(text).toContain("cleo");
  expect(text).toContain("design");
  expect(text).toContain("research");
});

test("sizes itself to the host rather than to the viewport", async () => {
  const el = host();
  await act(async () => {
    mount(el, { height: "420px" });
  });

  const container = el.shadowRoot?.firstElementChild?.nextElementSibling as HTMLElement;
  expect(container.style.height).toBe("420px");
  expect(container.style.getPropertyValue("--app-height")).toBe("100%");
});

test("opens with the graph alone, and every closed panel names itself", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture });
  });

  const app = el.shadowRoot?.querySelector(".app");
  // A cell is not a window: all three panels start out of the way.
  expect(app?.className).toContain("app-sidebar-collapsed");
  expect(app?.className).toContain("app-table-collapsed");
  expect(app?.className).toContain("app-stats-collapsed");

  // An arrow alone would not say which panel it opens, and here all three are
  // closed at once.
  const labels = [...(el.shadowRoot?.querySelectorAll(".panel-toggle-label") ?? [])].map(
    (n) => n.textContent,
  );
  expect(labels).toEqual(["Graph", "Data", "Info"]);
});

test("panels named by the host start open", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture, panels: ["stats"] });
  });

  const app = el.shadowRoot?.querySelector(".app");
  expect(app?.className).toContain("app-sidebar-collapsed");
  expect(app?.className).not.toContain("app-stats-collapsed");
});

test("a name the host made up is ignored rather than collapsing everything", async () => {
  const el = host();
  await act(async () => {
    // Reaches us across a language boundary, so it is not trusted to be real.
    mount(el, { workspace: fixture, panels: ["nonsense" as never, "table"] });
  });

  const app = el.shadowRoot?.querySelector(".app");
  expect(app?.className).not.toContain("app-table-collapsed");
});

test("the colour scheme lands on the host, where the popovers can see it", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture, theme: "light" });
  });

  // On the host and not on `.app`: the header popovers are portalled to the
  // shadow root, and custom properties have to reach them too.
  expect(el.getAttribute("data-theme")).toBe("light");
});

test("the app takes focus on a click, so the shortcuts have somewhere to land", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture });
  });

  // Nothing inside is focusable until a control is clicked, so without this a
  // click on the graph leaves focus with the notebook and H and P go to it.
  const app = el.shadowRoot?.querySelector<HTMLElement>(".app");
  expect(app?.tabIndex).toBe(-1);
});

test("drops the product title and the file step, which are the host's job", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture, panels: ["sidebar"] });
  });

  const text = el.shadowRoot?.textContent ?? "";
  expect(text).not.toContain("Data in, network out.");
  expect(text).not.toContain("Choose a file");
  // The promise is about a file the reader dropped. There was no file: the
  // data came out of their own kernel, so the sentence answers nothing.
  expect(text).not.toContain("never uploaded");
  // The steps that remain renumber, rather than starting at two.
  const steps = [...(el.shadowRoot?.querySelectorAll(".step-no") ?? [])].map((n) => n.textContent);
  expect(steps[0]).toBe("1");
  expect(steps).toHaveLength(6);
  // A divider goes between two sections; with no title above the first one it
  // would be a line across the top of the panel.
  expect(el.shadowRoot?.querySelector(".sidebar")?.className).toContain("sidebar-embedded");
});

test("a closed tab names its panel beside the arrow, not in place of it", async () => {
  const el = host();
  await act(async () => {
    mount(el, { workspace: fixture });
  });

  for (const [selector, name] of [
    [".sidebar-toggle", "Graph"],
    [".drawer-toggle", "Data"],
    [".stats-toggle", "Info"],
  ] as const) {
    const tab = el.shadowRoot?.querySelector(selector);
    expect(tab?.querySelector(".panel-toggle-arrow")).not.toBeNull();
    expect(tab?.querySelector(".panel-toggle-label")?.textContent).toBe(name);
  }
});
