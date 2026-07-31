/**
 * Invariants of the built widget bundle.
 *
 * The bundle is committed, so this reads the file a notebook would actually
 * load rather than the sources it was built from. Both checks are for things
 * that pass every source-level test and then throw in the browser: a bundle
 * that reaches for something only a bundler or Node provides, and a bundle
 * that is not the single file anywidget serves it as.
 */
import { expect, test } from "vitest";
import bundle from "../python/src/network_graph_viewer/static/widget.js?raw";

const emitted = import.meta.glob("../python/src/network_graph_viewer/static/*", { eager: false });

test("carries no reference to things only a bundler or Node would supply", () => {
  // React branches on this at module scope. A library build does not replace
  // it the way an app build does, so the config has to define it; left alone
  // the bundle throws "process is not defined" before it draws anything.
  expect(bundle).not.toMatch(/\bprocess\.env\b/);
  expect(bundle).not.toMatch(/\brequire\(/);
});

test("is one file, because that is all anywidget loads", () => {
  expect(Object.keys(emitted)).toHaveLength(1);
  // Nothing fetched at runtime either: the compute worker rides along as a
  // blob and QuickJS carries its WebAssembly inside the JavaScript.
  expect(bundle).not.toMatch(/import\(["'`]\.\//);
  expect(bundle).not.toMatch(/new URL\([^)]*import\.meta\.url/);
});

test("exports the render hook anywidget calls", () => {
  expect(bundle).toMatch(/render/);
  expect(bundle).toMatch(/export\s*\{/);
});
