import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  base: "/network-graph-viewer/",
  plugins: [react()],
  resolve: {
    alias: {
      // The page build fetches the compute worker as its own chunk. The embed
      // build swaps this for the inlining variant; see src/workers/spawn.ts.
      "#worker": src("./src/workers/spawn.ts"),
      "#duckdb": src("./src/lib/source/duckdb.ts"),
      // cosmos.gl's FPS monitor dependency points `browser` at a plain script
      // with no exports; its ESM build is the importable one.
      "gl-bench": "gl-bench/dist/gl-bench.module.js",
    },
  },
  test: {
    // Vitest stubs stylesheets out by default. The embed takes its own as
    // text and puts it in a shadow root, so for that one file the real
    // contents are the thing under test.
    css: { include: [/index\.css/] },
  },
});
