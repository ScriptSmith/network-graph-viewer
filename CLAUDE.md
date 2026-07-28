# Network Graph Viewer

A client-only Vite + React 19 + TypeScript SPA that turns edge lists
(CSV/Excel/GEXF/GraphML) into interactive network graphs. No backend; files
are parsed in memory. Deployed to GitHub Pages by `.github/workflows/deploy.yml`
on push to `main`.

## Commands

```sh
pnpm dev            # dev server at /network-graph-viewer/
pnpm build          # tsc -b && vite build (run this to type-check)
pnpm lint           # oxlint
pnpm test           # vitest run
pnpm format         # oxfmt (CI runs format:check; always format before commit)
```

## Architecture

The working document is a `GraphDoc`: an edge table plus a node table that
**always exists**, so nodes carry their own attributes and can outlive the
edges that named them. Everything downstream is derived from those two tables,
which is why editing the graph is just editing the tables.

```
GraphDoc -> buildBaseGraph -> applyChain (filters) -> applyStyle -> <GraphCanvas>
```

All state lives in `App.tsx`. The graph is read-only on the canvas; the only
way to change data is the data table, which edits the underlying rows.

- `src/types.ts` - shared types. `Column` carries an inferred `type`, set once
  at import. Style options are tagged strings: `metric:degree` |
  `column:<name>`; `styleColumn()` extracts the column.
- `src/lib/cells.ts` - cell coercion and the compound-key helpers. Keys join
  with a unit separator so ids with spaces or punctuation can't collide.
- `src/lib/doc.ts` - document assembly, node-table derivation and
  reconciliation, computed-column writes.
- `src/lib/graph.ts` - `buildBaseGraph` (structure) and `applyStyle`
  (appearance). Node style columns resolve against the node table first, then
  fall back to projecting from incident edge rows.
- `src/lib/filter.ts` - the filter chain. Steps apply **in order**, each seeing
  the subgraph the last one produced, so reordering changes the answer.
- `src/lib/metrics/` - every algorithm, hand-written. `model.ts` holds the
  compact `MetricGraph` the rest operate on; `index.ts` is the registry that
  drives the compute panel and writes results as ordinary columns.
- `src/lib/layouts/` - `positions: "physics" | "computed" | "external"` says
  where a layout's coordinates come from. ForceAtlas2 is a custom d3 force with
  Barnes-Hut repulsion via `d3-quadtree`.
- `src/lib/io/` - GEXF, GraphML, the native `.ngv.json` workspace, and gists.
- `src/lib/edit.ts` - pure `GraphDoc -> GraphDoc` transforms behind the data
  table's cell edits, row adds and row deletes.
- `src/lib/script/` - the QuickJS sandbox and the payload it receives.
- `src/workers/compute.worker.ts` - metrics and user scripts, off the main thread.
- `src/components/GraphCanvas.tsx` - the only place d3 touches the DOM. React
  renders the SVG shell; d3 owns joins, ticks, zoom, drag. One simulation
  powers everything: physics layouts use forces, computed layouts use strong
  forceX/forceY toward targets, so layout switches animate as morphs. Props are
  mirrored into `liveRef` so handlers installed once stay current; the scene
  re-joins only when `graph` changes.
- `src/theme.ts` - color tokens. The categorical palette is CVD-validated;
  slot order matters, don't reorder it.

## Constraints

- Graph marks are styled with SVG attributes, never CSS classes, so
  `lib/export.ts` can serialize a faithful standalone SVG (clone + background
  rect). Keep it that way when adding visuals.
- In-graph text uses system fonts (export fidelity); webfonts are for UI
  chrome only.
- **Algorithms are hand-written on purpose.** Dependencies are allowed for file
  formats, the table, and the JS engine; not for graph algorithms. Louvain runs
  in index order rather than shuffled so results are reproducible.
- `src/lib/graph.test.ts` holds a golden snapshot seeded from the original
  pre-node-table pipeline. If it changes, the core semantics changed.
- Computed columns are rounded for display via `displayCell`; imported values
  are shown exactly as they arrived.
- Vite `base` is `/network-graph-viewer/`; renaming the repo breaks Pages.
- `xlsx` is installed from the SheetJS CDN tarball (npm version is outdated
  and vulnerable); don't switch it to the npm registry version.
- Do not type raw escape sequences like the unit separator directly into
  tool-call strings when editing; they become literal control bytes in the file.
- XML writers must create every element with `createElementNS`, and must not
  set `xmlns` by hand on a root that `createDocument` already namespaced;
  either mistake produces a file that will not reparse.
