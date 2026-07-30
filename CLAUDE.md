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
  `column:<name>` | `cell:<name>`; `styleColumn()` extracts the column and
  `isCellStyle()` says which of the two column forms it is. `column:` maps the
  values onto a palette or a scale, `cell:` means the column already holds the
  answer, a color or a pixel size, so it lands on the mark untouched.
- `src/lib/cells.ts` - cell coercion and the compound-key helpers. Keys join
  with a unit separator so ids with spaces or punctuation can't collide.
- `src/lib/doc.ts` - document assembly, node-table derivation and
  reconciliation, computed-column writes.
- `src/lib/graph.ts` - `buildBaseGraph` (structure) and `applyStyle`
  (appearance). Node style columns resolve against the node table first, then
  fall back to projecting from incident edge rows. A `cell:` column puts its own
  color on `node.color`/`link.color` and its own pixel radius on `node.radius`,
  clamped, and leaves `group`/`groups` empty: the colors are their own key, so
  there is no legend and nothing to fold into "Other". `markColor()` is the one
  answer to what color a node is, asked by the canvas, the inspector and GEXF.
- `src/lib/filter.ts` - the filter chain. Steps apply **in order**, each seeing
  the subgraph the last one produced, so reordering changes the answer.
- `src/lib/metrics/` - every algorithm, hand-written. `model.ts` holds the
  compact `MetricGraph` the rest operate on; `index.ts` is the registry that
  drives the compute panel and writes results as ordinary columns.
- `src/lib/layouts/` - `positions: "physics" | "computed" | "external"` says
  where a layout's coordinates come from. ForceAtlas2 is a custom d3 force with
  Barnes-Hut repulsion via `d3-quadtree`.
- `src/lib/images.ts` - node image cells (`https` links, data URIs, bare
  base64, raw SVG markup) into something an `<image>` can draw, or null.
  Nothing else is let through: a cell is untrusted text.
- `src/lib/io/` - GEXF, GraphML, the native `.ngv.json` workspace, gists, and
  `url.ts`, which packs a workspace into a link's fragment and reads one back.
  Links put the data in the fragment, never the query: fragments are not sent
  with the request, so a shared graph stays as private as a dropped file.
- `src/lib/edit.ts` - pure `GraphDoc -> GraphDoc` transforms behind the data
  table's cell edits, row adds and row deletes. `coalesceById` is what makes a
  rename onto an existing id a merge rather than a ghost row the graph ignores.
- `src/lib/bulk.ts` - the same shape, one act over many cells or a whole
  column, so each lands in the undo history as one step. Everything at the
  value level goes through `mapColumn`, which knows the two columns that are
  not really values: the node id column, where an edit is a rename that has to
  reach both endpoint columns, and an endpoint column, where an edit can name
  a node nobody declared. Renaming several ids to one id **is** the node merge.
  A `RowScope` of `null` means every row; anything else is the rows in view.
  Column renames and deletes only do the document's half: style tokens and
  filter steps name columns by string and live outside it, so `retargetStyle`
  (doc.ts) and `retargetChain` (filter.ts) do the rest, called together from
  `App.tsx` so one act moves all three.
- `src/lib/script/` - the QuickJS sandbox and the payload it receives.
- `src/workers/compute.worker.ts` - metrics and user scripts, off the main thread.
- `src/components/ColumnMenu.tsx` - the pencil in a column header: rename,
  duplicate, retype, delete, find and replace, fill, and the value list whose
  "rename selected" is both a facet rename and, on the id column, a merge. It
  builds the transforms itself and hands up whole `GraphDoc` updates.
  `useHeaderPopover` + `HeaderPanel` position it and the filter funnel against
  the viewport, since the pane they hang in is often two rows tall.
- `src/components/GraphCanvas.tsx` - the only place d3 touches the DOM. React
  renders the SVG shell; d3 owns joins, ticks, zoom, drag. One simulation
  powers everything: physics layouts use forces, computed layouts use strong
  forceX/forceY toward targets, so layout switches animate as morphs. Props are
  mirrored into `liveRef` so handlers installed once stay current; the scene
  re-joins only when `graph` changes.
- `src/theme.ts` - color tokens, the shipped palettes and ramps, and
  `resolvePalette`, which turns a style's `palette`/`ramp` ids (or `custom`
  plus its own colors) into two arrays. The default categorical palette is
  CVD-validated; slot order matters, don't reorder it. Custom colors live in
  the style, so they travel with the workspace, and only `#rrggbb` survives
  `resolvePalette`: a workspace can arrive from a link anyone wrote.
- `src/samples/` - the shipped networks, one file each, listed in `index.ts`.
  Each is a different shape at a different size; `sample()` counts them for the
  picker. The first, supervision, is also the graph drifting behind the empty
  state and the fixture behind `graph.test.ts`, so its rows are frozen. The
  toolchain sample is the one exception to the app never touching the network:
  its node table holds Simple Icons URLs, whose CDN serves them cross-origin.
  The transit sample is the one styled by `cell:` columns; `samples.test.ts`
  holds every shipped cell colour to reading as a colour, since one that didn't
  would come out neutral rather than failing.

## Constraints

- Graph marks are styled with SVG attributes, never CSS classes, so
  `lib/export.ts` can serialize a faithful standalone SVG (clone + background
  rect). Keep it that way when adding visuals.
- Node images are `<pattern>` fills in bounding-box units, one per distinct
  source, so a node stays a single circle to hit, drag, dim and export, and
  the pattern sizes itself to whatever radius the node has. A source that
  fails to load is dropped from the defs, or the browser draws its broken-image
  glyph inside the node. Remote images can't reach a PNG export: rasterizing
  goes through an SVG loaded as an image, which fetches nothing.
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
