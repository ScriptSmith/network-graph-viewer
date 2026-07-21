# Network Graph Viewer

Turn a spreadsheet edge list into an interactive network graph, entirely in your browser.

**Live app:** https://adamsm.com/network-graph-viewer/

![The sample supervision network rendered as a force-directed graph, with nodes colored by department and a sidebar for data, filters, style, and layout](docs/screenshot.png)

## Features

- Upload Excel (`.xlsx`, `.xls`, `.ods`) or CSV files; everything is parsed in memory and never leaves the browser
- Pick which columns are the edge source and target and which columns show up as edge details
- Gephi-style appearance controls: color nodes by a categorical column or a numeric ranking (sequential ramp), size nodes by connections or a summed column, color edges by a column, width edges by a numeric column, toggle direction arrows, adjust spacing
- Filter rows per column (value checkboxes for categories, min/max for numbers); the graph, legend, and stats all follow the filtered data
- Pivot-style statistics panel: overview tiles (nodes, edges, average links, components), group-by breakdowns with count/sum/average measures, top nodes, and click-to-filter bars
- Network metrics with plain-language explanations: density, diameter, average path length, clustering coefficient, and degree/betweenness/closeness/eigenvector centrality, which can also rank the top-nodes list and drive node color and size
- Built-in sample dataset: a Supervisor to Supervisee network with edge attributes (department, cadence, meetings per month, years together)
- Animated, interactive SVG graph: pan, zoom, drag nodes, hover to highlight neighborhoods, click a node for a detail inspector
- Five layouts that morph into each other: force, hierarchy, radial, circle, grid
- Export the current view as SVG or PNG

## Development

```sh
pnpm install
pnpm dev          # start the dev server
pnpm build        # type-check and build to dist/
pnpm lint         # oxlint
pnpm format       # oxfmt
```

## Stack

- [Vite](https://vite.dev/) + [React 19](https://react.dev/) + TypeScript
- [d3-force](https://d3js.org/d3-force), d3-zoom and d3-drag for simulation and interaction
- [SheetJS](https://sheetjs.com/) for Excel and CSV parsing
- Deployed with GitHub Pages
