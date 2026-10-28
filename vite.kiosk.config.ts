import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** A kiosk may run with nothing but its own files to hand, so no web fonts. */
const withoutWebFonts = (): Plugin => ({
  name: "kiosk-without-web-fonts",
  transformIndexHtml: (html) =>
    html.replace(/\s*<link[^>]*(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, ""),
});

/**
 * The page build for a host that embeds it as a kiosk (`?kiosk=…`): relative
 * paths so it can sit under any folder, and no query engine, which a kiosk
 * cannot import data for anyway. That leaves out about 8 MB of WebAssembly the
 * page build ships for opening large files.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), withoutWebFonts()],
  resolve: {
    alias: {
      "#worker": src("./src/workers/spawn.ts"),
      "#duckdb": src("./src/lib/source/duckdb.absent.ts"),
      "gl-bench": "gl-bench/dist/gl-bench.module.js",
    },
  },
  build: { outDir: src("./dist-kiosk"), chunkSizeWarningLimit: 4000 },
});
