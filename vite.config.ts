import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  base: "/network-graph-viewer/",
  plugins: [react()],
  resolve: {
    // The page build fetches the compute worker as its own chunk. The embed
    // build swaps this for the inlining variant; see src/workers/spawn.ts.
    alias: { "#worker": src("./src/workers/spawn.ts") },
  },
  test: {
    // Vitest stubs stylesheets out by default. The embed takes its own as
    // text and puts it in a shadow root, so for that one file the real
    // contents are the thing under test.
    css: { include: [/index\.css/] },
  },
});
