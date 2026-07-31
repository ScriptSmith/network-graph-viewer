# network-graph-viewer

Interactive network graphs in a Jupyter notebook, from the
[Network Graph Viewer](https://adamsm.com/network-graph-viewer/).

The whole app runs in the cell output: the sidebar, the filters, the metrics,
the data table. Nothing is sent anywhere. The graph goes out to the browser as
the app's own workspace format, and the selection and any edits come back.

## Install

```sh
uv add network-graph-viewer
```

or `pip install network-graph-viewer`. Nothing else is needed: the widget ships
its own JavaScript, and pandas and networkx are only used if you hand it one of
theirs.

## Use

```python
import network_graph_viewer as ngv
import pandas as pd

edges = pd.DataFrame(
    [
        {"from": "ana", "to": "ben", "weight": 3, "team": "design"},
        {"from": "ben", "to": "cleo", "weight": 1, "team": "design"},
    ]
)

w = ngv.show(edges, source="from", target="to", color="team")
w
```

`edges` can also be a list of dicts, a list of `(source, target)` pairs, or a
networkx graph, in which case the node attributes come with it:

```python
import networkx as nx

ngv.show(nx.karate_club_graph(), color="club")
```

Node attributes that live in their own table go in as `nodes`, and any node an
edge names but the table does not gets a row anyway:

```python
ngv.show(edges, source="from", target="to", nodes=people, node_id="Id")
```

### What the cell shows

The cell shows the graph and nothing else. Every panel has a labelled tab on the
edge of the stage that opens it, and `panels=` opens any of them to start with:

```python
ngv.show(edges, source="from", target="to", panels=["sidebar", "table"])
```

The widget follows the notebook's own light or dark theme and keeps following
it, so switching the JupyterLab theme switches the graph too. Pin it with
`theme="light"` or `theme="dark"`, or change it live in the View menu on the
graph.

### Reading the graph back

The widget is live. Click a node, edit a cell, run a metric, and the kernel
sees it:

```python
w.selected_node  # 'ana', or None
w.edges  # the edge table as a DataFrame, edits included
w.nodes  # likewise, with any computed columns
w.save("graph.ngv.json")
```

`w.edges` and `w.nodes` are `None` until the browser has reported something,
which it does shortly after the widget first draws.

## How it works

The graph is handed to the browser as the app's own `.ngv.json` workspace, so a
notebook goes in through the same door as a dropped file or a shared link, and
meets the same reader on the other side. What comes back is the selection and
the edited tables. Nothing is uploaded: the kernel and the browser are talking
over the notebook's own connection.

`build_workspace` is that translation on its own, if you want the dictionary
without a widget:

```python
workspace = ngv.build_workspace(edges, source="from", target="to")
```

Every cell has to survive the trip as JSON, so NumPy scalars, timestamps and
decimals are each converted to the nearest thing a cell can hold, and an
integer too large for a JSON number keeps its digits as text rather than
rounding into a collision.

## Development

The widget loads one JavaScript file,
`src/network_graph_viewer/static/widget.js`. It is built from the TypeScript
app at the repository root and is **not** in the repository: a fresh clone has
to build it before the package will run, and so does anything that rebuilds
the app.

```sh
pnpm install            # once, at the repository root
pnpm build:widget       # writes static/widget.js
```

Then, in this directory:

```sh
uv sync
uv run pytest
uv run pytest --nbmake examples/demo.ipynb
uv run ruff check && uv run ruff format
```

The release workflow builds the bundle from the source at the tag, so what
gets published is never taken on trust from anybody's working tree.
