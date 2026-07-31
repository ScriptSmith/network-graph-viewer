"""The notebook widget.

anywidget carries one ES module and a handful of traitlets between the kernel
and the browser. The module is the whole app, built by ``pnpm build:widget``
and committed alongside this file, so installing from git is enough and no
JavaScript toolchain has to exist on the machine that installs it.

What crosses the wire is deliberately lopsided. The graph goes out as workspace
text, which is the app's own format. What comes back is the selection and the
edited tables, and nothing that comes back is ever sent out again, or the two
ends would talk past each other forever.
"""

from __future__ import annotations

import json
import pathlib
from collections.abc import Sequence
from typing import Any

import anywidget
import traitlets

from .workspace import build_workspace

#: The built app. One file, committed, because a git install cannot build it.
BUNDLE = pathlib.Path(__file__).parent / "static" / "widget.js"

#: Where the app is published. Share links built inside a notebook point here,
#: since the notebook's own address would take nobody anywhere.
APP_URL = "https://adamsm.com/network-graph-viewer/"

#: The side panels, by the names the app knows them by.
PANELS = ["sidebar", "table", "stats"]

#: "auto" reads the notebook's own colour scheme, whatever frontend it is.
THEMES = ["auto", "light", "dark"]


class GraphWidget(anywidget.AnyWidget):
    """An interactive network graph, rendered in the notebook output.

    Read :attr:`selected_node` for whatever is selected on the canvas, and
    :attr:`edges` or :attr:`nodes` for the tables as they now stand, edits
    included.
    """

    _esm = BUNDLE

    workspace = traitlets.Unicode("").tag(sync=True)
    height = traitlets.Unicode("700px").tag(sync=True)
    app_url = traitlets.Unicode(APP_URL).tag(sync=True)

    #: Which side panels start open. None of them by default: a notebook cell
    #: is not a window, and the graph is what the cell is for. Every panel has
    #: a labelled tab on the stage's edge that opens it.
    panels = traitlets.List(traitlets.Enum(PANELS), default_value=[]).tag(sync=True)
    #: "auto" follows the notebook's own light or dark theme and keeps
    #: following it; "light" and "dark" pin it. The View menu sets it too.
    theme = traitlets.Enum(THEMES, default_value="auto").tag(sync=True)

    #: The id of the selected node, or None when nothing is selected.
    selected_node = traitlets.Unicode(None, allow_none=True).tag(sync=True)
    #: The working document as it stands in the browser, edits included.
    #: None until the browser has reported one, which it does shortly after
    #: the widget first draws.
    doc = traitlets.Dict(default_value=None, allow_none=True).tag(sync=True)

    def __init__(self, workspace: dict[str, Any] | str, **kwargs: Any) -> None:
        if not BUNDLE.exists():  # pragma: no cover - only in a half-built tree
            raise RuntimeError(
                f"The widget bundle is missing from {BUNDLE}. Build it with "
                "`pnpm build:widget` at the repository root."
            )
        if isinstance(workspace, dict):
            workspace = json.dumps(workspace)
        super().__init__(workspace=workspace, **kwargs)

    # -- Reading the graph back --------------------------------------------

    def _table(self, which: str) -> dict[str, Any] | None:
        doc = self.doc
        return doc.get(which) if doc else None

    @property
    def edges(self) -> Any:
        """The edge table as it now stands, as a DataFrame if pandas is installed."""
        return _as_frame(self._table("edges"))

    @property
    def nodes(self) -> Any:
        """The node table as it now stands, as a DataFrame if pandas is installed."""
        return _as_frame(self._table("nodes"))

    def to_json(self, *, indent: int | None = 2) -> str:
        """The workspace as ``.ngv.json`` text, with any edits folded back in."""
        workspace = json.loads(self.workspace) if self.workspace else {}
        if self.doc:
            workspace["doc"] = self.doc
        return json.dumps(workspace, indent=indent)

    def save(self, path: str | pathlib.Path) -> pathlib.Path:
        """Write the workspace to a file the app can open."""
        path = pathlib.Path(path)
        path.write_text(self.to_json(), encoding="utf-8")
        return path


def _as_frame(table: dict[str, Any] | None) -> Any:
    """A table as a DataFrame, or as its plain rows where pandas is absent."""
    if table is None:
        return None
    rows = table.get("rows", [])
    try:
        import pandas
    except ImportError:
        return rows
    return pandas.DataFrame(rows, columns=[c["name"] for c in table.get("columns", [])])


def show(
    edges: Any,
    *,
    height: str = "700px",
    panels: Sequence[str] = (),
    theme: str = "auto",
    app_url: str = APP_URL,
    **kwargs: Any,
) -> GraphWidget:
    """Draw a graph in the notebook.

    ``edges`` may be a DataFrame, a sequence of mappings, a sequence of
    ``(source, target)`` pairs, or a networkx graph. Everything else is passed
    to :func:`~network_graph_viewer.workspace.build_workspace`::

        ngv.show(df, source="from", target="to", color="dept")

    The cell shows the graph and nothing else. ``panels`` opens any of
    ``"sidebar"``, ``"table"`` and ``"stats"`` to start with, and each has a
    labelled tab on the edge of the stage whether it is open or not.
    ``theme`` is ``"auto"``, ``"light"`` or ``"dark"``.
    """
    return GraphWidget(
        build_workspace(edges, **kwargs),
        height=height,
        panels=list(panels),
        theme=theme,
        app_url=app_url,
    )
