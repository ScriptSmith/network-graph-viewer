import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The notebook widget: the whole app as one ES module.
 *
 * anywidget loads a single file out of the Python package, so nothing here may
 * fetch a second one. That costs three swaps against the page build. The
 * compute worker is inlined as a blob rather than fetched as a chunk; QuickJS
 * comes from the variant carrying its WebAssembly inside the JavaScript rather
 * than beside it; and every lazy import is folded in, because a dynamic import
 * of a sibling chunk has no URL to resolve against once the module is served
 * from a Python package. The stylesheet is already handled: `embed.tsx` takes
 * it as text with `?inline` and puts it in the shadow root.
 */
export default defineConfig({
  plugins: [react()],
  // `public/` holds the page build's extra assets (the standalone bundle);
  // without this the lib build would copy them in beside widget.js.
  publicDir: false,
  // A library build leaves this alone, where an app build would have replaced
  // it. React reads it at module scope to pick its development or production
  // half, so without this the bundle throws on `process is not defined` before
  // it draws anything.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "#worker": src("./src/workers/spawn.inline.ts"),
      "#duckdb": src("./src/lib/source/duckdb.absent.ts"),
      "@jitl/quickjs-wasmfile-release-sync": "@jitl/quickjs-singlefile-browser-release-sync",
      // cosmos.gl's FPS monitor dependency points `browser` at a plain script
      // with no exports; its ESM build is the importable one.
      "gl-bench": "gl-bench/dist/gl-bench.module.js",
    },
  },
  build: {
    outDir: src("./python/src/network_graph_viewer/static"),
    emptyOutDir: true,
    // The output is not committed, but it is what ships inside the wheel and
    // what a notebook downloads before it can draw anything.
    minify: true,
    // The wasm-in-JS variant is one large string; warning about it every build
    // would only train us to ignore the warning.
    chunkSizeWarningLimit: 4000,
    lib: {
      entry: src("./src/widget.ts"),
      formats: ["es"],
      fileName: () => "widget.js",
    },
    rollupOptions: {
      output: { codeSplitting: false },
    },
  },
});
