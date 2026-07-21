# Network Graph Viewer

A client-only Vite + React 19 + TypeScript SPA that turns spreadsheet edge
lists (CSV/Excel) into interactive network graphs. No backend; files are
parsed in memory. Deployed to GitHub Pages by `.github/workflows/deploy.yml`
on push to `main`.

## Commands

```sh
pnpm dev            # dev server at /network-graph-viewer/
pnpm build          # tsc -b && vite build (run this to type-check)
pnpm lint           # oxlint
pnpm format         # oxfmt (CI runs format:check; always format before commit)
```

## Architecture

Data flows one way: sheet rows -> `applyFilters` -> `buildGraph(rows,
mapping, style)` -> `<GraphCanvas>` + `<StatsPanel>`. All state lives in
`App.tsx`; a new graph object triggers a d3 re-join, and node positions are
preserved across rebuilds by node id.

- `src/types.ts` - shared types. Style options are tagged strings:
  `metric:degree` | `column:<name>` etc; `styleColumn()` extracts the column.
- `src/lib/parse.ts` - SheetJS parsing (lazy import keeps it out of the main
  chunk), numeric-column detection, source/target/style guessing.
- `src/lib/graph.ts` - graph build, filters, pivot helpers. Compound map keys
  use the `\u001F` escape as separator so node names with spaces can't collide.
- `src/lib/metrics.ts` - density/diameter/path length/clustering and the four
  centralities, all undirected; BFS sources are sampled past 600 nodes.
- `src/lib/layouts.ts` - static layout target positions (hierarchy, radial,
  circle, grid), centered on the origin.
- `src/components/GraphCanvas.tsx` - the only place d3 touches the DOM.
  React renders the SVG shell; d3 owns joins, ticks, zoom, drag. One force
  simulation powers everything: the force layout uses physics, static
  layouts use strong forceX/forceY toward computed targets, so layout
  switches animate as morphs. Props are mirrored into `liveRef` so handlers
  installed once stay current; the scene re-joins only when `graph` changes.
- `src/theme.ts` - color tokens. The categorical palette is CVD-validated;
  slot order matters, don't reorder it.

## Constraints

- Graph marks are styled with SVG attributes, never CSS classes, so
  `lib/export.ts` can serialize a faithful standalone SVG (clone + background
  rect). Keep it that way when adding visuals.
- In-graph text uses system fonts (export fidelity); webfonts are for UI
  chrome only.
- Vite `base` is `/network-graph-viewer/`; renaming the repo breaks Pages.
- `xlsx` is installed from the SheetJS CDN tarball (npm version is outdated
  and vulnerable); don't switch it to the npm registry version.
- Do not type raw escape sequences like `\u001F` directly into tool-call
  strings when editing; they become literal control bytes in the file.
