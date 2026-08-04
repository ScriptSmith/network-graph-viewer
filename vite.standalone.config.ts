import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The bundle the HTML export inlines: the embed entry, self-contained the way
 * the widget build is (worker as a blob, QuickJS with its WebAssembly inside
 * the JavaScript, styles as text), because the exported file is one document
 * with nowhere to fetch a sibling chunk from.
 *
 * It lands in `public/`, so the page build ships it as a plain asset and the
 * exporter can fetch it at export time. Generated, not committed.
 */
export default defineConfig({
  plugins: [react()],
  // The output directory is also the default public directory; copying it
  // into itself is not a build step anybody meant.
  publicDir: false,
  // Same as the widget build: a library build leaves process.env alone, and
  // React reads it at module scope.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "#worker": src("./src/workers/spawn.inline.ts"),
      "@jitl/quickjs-wasmfile-release-sync": "@jitl/quickjs-singlefile-browser-release-sync",
      // cosmos.gl's FPS monitor dependency points `browser` at a plain script
      // with no exports; its ESM build is the importable one.
      "gl-bench": "gl-bench/dist/gl-bench.module.js",
    },
  },
  build: {
    outDir: src("./public"),
    // The page build copies `public/` wholesale; nothing else lives there,
    // but emptying somebody's asset directory is not this build's call.
    emptyOutDir: false,
    minify: true,
    chunkSizeWarningLimit: 4000,
    lib: {
      entry: src("./src/standalone.ts"),
      formats: ["es"],
      fileName: () => "standalone.js",
    },
    rollupOptions: {
      output: { codeSplitting: false },
    },
  },
});
