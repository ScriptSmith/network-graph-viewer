<img src="docs/icon.svg" width="128" height="128" alt="A ten-node network cycling through the force, circle, grid, radial and grouped layouts, recolouring and resizing as it moves">

# Network Graph Viewer

> [!NOTE]
> This project is AI-generated: the code, sample data, and this README were written by [Claude Code](https://claude.com/claude-code).

Turn a spreadsheet edge list into an interactive network graph, in your browser or a Jupyter notebook.

**Live app:** https://adamsm.com/network-graph-viewer/

![The sample supervision network as a force-directed graph, nodes coloured by department, with the sidebar for data, filters, style and layout on the left, a statistics panel of network metrics and top nodes on the right, and the edge table below](docs/screenshot.png)

## Features

### Getting data in

- Upload Excel (`.xlsx`, `.xls`, `.ods`), CSV or Parquet files; everything is parsed in memory and never leaves the browser
- Parquet is read column-typed straight from its own schema, so a zero-padded id column stays text instead of being guessed into a number, and only the byte ranges the file actually needs are read
- Paste cells straight from Excel or Google Sheets
- Import JSON and line-delimited JSON (`.json`, `.jsonl`, `.ndjson`): an array of records reads as an edge table, and node-link, the shape d3 and NetworkX write, arrives as nodes and edges at once with the attributes already on the nodes. JSON states its own types, so a zero-padded id stays text here too
- Import GEXF and GraphML, including node and edge attributes and Gephi's saved positions
- Import Graphviz DOT (`.dot`, `.gv`): defaults, subgraphs and edge chains are flattened onto the tables, clusters arrive as a node column, and a file Graphviz has already laid out keeps its positions
- Open a `#data=…` link and the graph it carries is already there; nothing is fetched
- Load from a public GitHub gist by URL or id, or share a `?gist=…` link that opens straight into the graph
- A workbook with several sheets can use one as the edges and another as node attributes

### Shaping the graph

- Pick which columns are the edge source and target and which show up as edge details
- Nodes are first-class: they keep their own attributes and can exist without any edges
- A data table over both the node and edge tables: search, sort, group with count/sum/average/min/max, hide columns, add and delete rows, and edit any cell with the graph updating as you type

### Styling

- Colour nodes by a column or a network metric, size them by degree or any number column, and colour and weight the edges the same way
- Or let the data do the styling: a column of colours (`#b7410e`, `#b41`, `rgb(183, 65, 14)` or a colour name) paints the nodes and edges exactly as written, and a column of numbers sets radii and stroke widths in pixels, no palette or scale in the way. The shipped **Metro lines** sample is the case for it, a network whose colours are its identity rather than a category to map
- Four categorical palettes, including the published colourblind-safe Okabe-Ito and Tol bright sets, and four ramps for numeric rankings
- Light and dark, switchable in the View menu, and the graph's own colours change with it rather than only the chrome around them
- Or build your own: edit any slot, add and remove colours, and the palette travels with the workspace, the export and the shared link
- Node images from a column of `https` links, data URIs, bare base64, or SVG markup: the picture fills the node and its colour becomes the ring, so an image costs nothing the colours were saying. The shipped **Web toolchain** sample is 42 projects wearing their logos, and the one place the app fetches anything from a third party. A graph that arrives from a link or a file asks first, since requesting an image tells that server you opened the graph

### Reading it without a mouse

Tab into the graph and you land on the most connected node; left and right walk
every node in turn, up and down walk the neighbours, Enter selects. Focus is
announced, and anything that moves for effect stops when your system asks for
less motion.

### Filters that chain

Filters apply in order, each one seeing the subgraph the last produced, so
`two steps out from Alex` followed by `degree ≥ 2` measures degree _inside that
neighbourhood_. Reordering the same two steps asks a different question.

- Column values on either the nodes or the edges
- Degree range, k-core, largest components, ego networks, reciprocated edges only
- Disparity backbone: keep only the edges carrying more weight than their endpoints' other edges can explain

### Measures

Computed on demand and written back as ordinary columns, so every result can
immediately drive colour and size, be filtered on, sorted in the table, and
travel into an export.

- Degree, in-degree, out-degree, PageRank, HITS hub and authority, betweenness, closeness, harmonic closeness, eigenvector
- Louvain modularity classes, with a resolution control; deterministic, so a rerun gives the same communities
- k-core, triangle counts, connected components
- Edge measures: shared neighbours, Simmelian strength, disparity-filter significance
- Whole-graph metrics with plain-language explanations: density, diameter, average path length, clustering

### Layouts

Ten layouts that morph into one another rather than jumping:

- **ForceAtlas2** with repulsion, gravity, LinLog and edge-weight controls, Barnes-Hut accelerated
- **Force**, **hierarchy**, **radial**, **circle**, **grid**
- **Force (GPU)**, cosmos.gl's simulation on the graphics card, for graphs the CPU layouts crawl on; it appears when the WebGL renderer is drawing
- **Geographic**, nodes at their real coordinates from two columns
- **Circle pack**, one disc per group
- **Scripted**, positions from your own code
- Plus an anti-overlap force, a one-shot Noverlap pass, and a Pause button whenever a simulation is running

### Renderers

Three ways to draw the same scene, switchable in the View menu, with the
layout, camera, selection and keyboard all carrying across the switch:

- **SVG**, the default: the sharpest marks, and the only renderer that can
  export the scene as SVG
- **Canvas**: one drawing surface instead of one element per mark, for graphs
  in the tens of thousands of edges
- **WebGL**: [cosmos.gl](https://github.com/cosmosgl/graph) drawing from typed
  arrays, for graphs in the hundreds of thousands, with its own GPU force
  layout to match

A graph that arrives past a size threshold is asked which renderer to use
before anything is drawn, because at that size the first paint is itself the
problem. PNG export works under every renderer by repainting the scene
offscreen; the choice is remembered on this device rather than travelling
with the graph.

### Writing your own

Metrics and layouts you write yourself, run in [QuickJS](https://bellard.org/quickjs/)
compiled to WebAssembly inside a Web Worker. A script gets a 3 second deadline,
a 64 MB ceiling, seeded randomness, and an empty global scope with no network
access.

### Getting data out

- SVG and PNG of the current view
- GEXF including positions and colours, so Gephi opens it looking like it did here
- GraphML with typed attribute keys
- Graphviz DOT carrying the colours and sizes on screen, and, for a graph that has been laid out, every node pinned where it sits so `neato` draws the same picture
- A `.ngv.json` workspace holding everything: both tables, the filter chain, styling, layout and node positions
- CSV of the edge table
- A link with the whole workspace deflated into its fragment, so sharing the graph is sharing a URL and the data still never reaches a server
- Save any of it to a GitHub gist with a personal access token, which puts the gist's id in the address bar for a link that stays short whatever the graph weighs

## In a Jupyter notebook

The same app runs in a notebook cell, as a widget. Click a node and the kernel
sees the selection; edit the table and the edits come back as a DataFrame.

```sh
pip install network-graph-viewer
```

or:

```sh
uv add network-graph-viewer
```

```python
import network_graph_viewer as ngv

w = ngv.show(edges_df, source="from", target="to", color="team")
w                   # the graph, interactive, in the output

w.selected_node     # 'ana'
w.edges             # the edge table, edits and computed columns included
```

A DataFrame, a list of dicts, a list of `(source, target)` pairs or a networkx
graph all work. The cell shows the graph alone, with a labelled tab on each edge
for the panels, and follows the notebook's own light or dark theme. A notebook
that knows its graph is big can start the viewer on the renderer that suits it:
`ngv.show(df, source="from", target="to", renderer="webgl")`. See
[`python/`](python/) and [the example notebook](python/examples/demo.ipynb).

## Development

```sh
pnpm install
pnpm dev            # start the dev server
pnpm build          # type-check and build to dist/
pnpm build:widget   # rebuild the notebook bundle (generated, not committed)
pnpm lint           # oxlint
pnpm test           # vitest
pnpm format         # oxfmt
```

The notebook package lives in `python/` and is managed with `uv`:

```sh
cd python
uv sync
uv run pytest
uv run pytest --nbmake examples/demo.ipynb
```

## Stack

- [Vite](https://vite.dev/) + [React 19](https://react.dev/) + TypeScript
- [d3-force](https://d3js.org/d3-force), d3-zoom, d3-drag and d3-quadtree for simulation and interaction
- [cosmos.gl](https://github.com/cosmosgl/graph) for the WebGL renderer and its GPU force layout
- [SheetJS](https://sheetjs.com/) for Excel and CSV parsing
- [hyparquet](https://github.com/hyparam/hyparquet) for Parquet, with [hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors) for snappy, gzip, zstd and the rest
- [anywidget](https://anywidget.dev/) for the Jupyter widget
- [TanStack Table](https://tanstack.com/table) and [TanStack Virtual](https://tanstack.com/virtual) for the data grid
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) for the script sandbox
- GEXF and GraphML are read and written with the platform's own `DOMParser`; DOT has a hand-written lexer and parser, since it is neither XML nor a table
- Deployed with GitHub Pages
