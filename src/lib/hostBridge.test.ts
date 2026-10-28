import { expect, test } from "vitest";
import { MAX_WORKSPACE_CHARS, parseHostCommand } from "./hostBridge";
import { kioskAllows, readKiosk } from "./kiosk";

const msg = (m: Record<string, unknown>) => ({ ngv: 1, ...m });

test("messages without the tag or version are ignored", () => {
  expect(parseHostCommand({ type: "fit" })).toBeNull();
  expect(parseHostCommand({ ngv: 2, type: "fit" })).toBeNull();
  expect(parseHostCommand("fit")).toBeNull();
  expect(parseHostCommand(null)).toBeNull();
  expect(parseHostCommand([msg({ type: "fit" })])).toBeNull();
});

test("a workspace may arrive as text or as an object", () => {
  expect(parseHostCommand(msg({ type: "load", workspace: "{}" }))).toEqual({
    type: "load",
    workspace: "{}",
  });
  expect(parseHostCommand(msg({ type: "load", workspace: { a: 1 } }))).toEqual({
    type: "load",
    workspace: '{"a":1}',
  });
  expect(parseHostCommand(msg({ type: "load", workspace: 5 }))).toBeNull();
  const huge = "x".repeat(MAX_WORKSPACE_CHARS + 1);
  expect(parseHostCommand(msg({ type: "load", workspace: huge }))).toBeNull();
});

test("select takes a node id or null, and centres unless told not to", () => {
  expect(parseHostCommand(msg({ type: "select", id: "a" }))).toEqual({
    type: "select",
    id: "a",
    center: true,
  });
  expect(parseHostCommand(msg({ type: "select", id: null, center: false }))).toEqual({
    type: "select",
    id: null,
    center: false,
  });
  expect(parseHostCommand(msg({ type: "select", id: 3 }))).toBeNull();
  expect(parseHostCommand(msg({ type: "select" }))).toBeNull();
});

test("only layouts that need nothing extra can be asked for", () => {
  expect(parseHostCommand(msg({ type: "layout", id: "radial" }))).toEqual({
    type: "layout",
    id: "radial",
  });
  expect(parseHostCommand(msg({ type: "layout", id: "script" }))).toBeNull();
  expect(parseHostCommand(msg({ type: "layout", id: "nope" }))).toBeNull();
});

test("themes and unknown types are checked", () => {
  expect(parseHostCommand(msg({ type: "theme", theme: "light" }))).toEqual({
    type: "theme",
    theme: "light",
  });
  expect(parseHostCommand(msg({ type: "theme", theme: "pink" }))).toBeNull();
  expect(parseHostCommand(msg({ type: "format-disk" }))).toBeNull();
});

test("kiosk mode is on only when the address asks, from query or fragment", () => {
  const home = "https://example.com/ngv/";
  expect(readKiosk(home)).toBeNull();
  expect(readKiosk(`${home}?kiosk=0`)).toBeNull();
  expect(readKiosk(`${home}?kiosk=1`)).toEqual({
    level: "touch",
    theme: undefined,
    renderer: undefined,
    card: true,
    expand: false,
  });
  expect(readKiosk(`${home}#kiosk=panels&theme=light&renderer=canvas&card=0`)).toEqual({
    level: "panels",
    theme: "light",
    renderer: "canvas",
    card: false,
    expand: true,
  });
  expect(readKiosk(`${home}?kiosk=1&theme=bogus&renderer=bogus`)?.theme).toBeUndefined();
});

test("a kiosk step names how much of the app is shown", () => {
  const home = "https://example.com/ngv/";
  const level = (v: string) => readKiosk(`${home}?kiosk=${v}`)?.level;
  expect(["display", "touch", "panels", "app"].map(level)).toEqual([
    "display",
    "touch",
    "panels",
    "app",
  ]);
  expect(level("")).toBe("touch");
  expect(level("view")).toBe("touch");
  expect(level("APP")).toBe("app");
  // Anything unrecognised gets the least rather than the most.
  expect(level("everything")).toBe("display");
});

test("a double tap narrows the graph only where the panels can undo it, or when asked", () => {
  const home = "https://example.com/ngv/";
  const expand = (q: string) => readKiosk(`${home}?${q}`)?.expand;
  expect(expand("kiosk=touch")).toBe(false);
  expect(expand("kiosk=touch&expand=1")).toBe(true);
  expect(expand("kiosk=panels")).toBe(true);
  expect(expand("kiosk=app&expand=0")).toBe(false);
});

test("a step allows what the steps below it do", () => {
  const at = (l: "display" | "touch" | "panels" | "app") => ({
    level: l,
    card: true,
    expand: false,
  });
  expect(kioskAllows(null, "app")).toBe(true);
  expect(kioskAllows(at("touch"), "touch")).toBe(true);
  expect(kioskAllows(at("touch"), "panels")).toBe(false);
  expect(kioskAllows(at("app"), "panels")).toBe(true);
  expect(kioskAllows(at("display"), "touch")).toBe(false);
});
