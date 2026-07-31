"""Network Graph Viewer, in a notebook.

import network_graph_viewer as ngv

w = ngv.show(edges, source="from", target="to", color="dept")
w                      # the graph, interactive, in the cell output
w.selected_node        # whatever is selected on the canvas
w.edges                # the edge table, edits included
"""

from .widget import APP_URL, BUNDLE, GraphWidget, show
from .workspace import build_workspace, to_cell, to_table

__all__ = [
    "APP_URL",
    "BUNDLE",
    "GraphWidget",
    "build_workspace",
    "show",
    "to_cell",
    "to_table",
]

__version__ = "0.1.0"
