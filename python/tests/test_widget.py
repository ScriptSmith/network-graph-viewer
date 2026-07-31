import json

import pandas as pd
import pytest

import network_graph_viewer as ngv

EDGES = [
    {"from": "ana", "to": "ben", "weight": 3},
    {"from": "ben", "to": "cleo", "weight": 1},
]


def test_show_builds_a_widget_carrying_the_workspace():
    widget = ngv.show(EDGES, source="from", target="to", name="Team")

    workspace = json.loads(widget.workspace)
    assert workspace["doc"]["name"] == "Team"
    assert widget.height == "700px"
    assert widget.app_url == ngv.APP_URL


def test_the_bundle_the_widget_loads_is_actually_there():
    # The one file that makes this package work in a notebook, and the one
    # that a git install has no way to rebuild.
    assert ngv.BUNDLE.exists()
    assert ngv.BUNDLE.stat().st_size > 100_000


def test_nothing_is_selected_and_no_document_has_come_back_yet():
    widget = ngv.show(EDGES, source="from", target="to")
    assert widget.selected_node is None
    assert widget.doc is None
    assert widget.edges is None
    assert widget.nodes is None


def test_the_tables_come_back_as_frames_once_the_browser_reports_them():
    widget = ngv.show(EDGES, source="from", target="to")
    # Standing in for the browser, which writes this trait after an edit.
    widget.doc = json.loads(widget.workspace)["doc"]

    edges = widget.edges
    assert isinstance(edges, pd.DataFrame)
    assert list(edges.columns) == ["from", "to", "weight"]
    assert len(edges) == 2
    assert list(widget.nodes["Id"]) == ["ana", "ben", "cleo"]


def test_saving_folds_the_edits_back_into_the_workspace(tmp_path):
    widget = ngv.show(EDGES, source="from", target="to")
    edited = json.loads(widget.workspace)["doc"]
    edited["name"] = "Edited"
    widget.doc = edited

    path = widget.save(tmp_path / "graph.ngv.json")
    written = json.loads(path.read_text())

    assert written["doc"]["name"] == "Edited"
    assert written["format"] == "network-graph-viewer"


def test_the_workspace_survives_a_json_round_trip():
    widget = ngv.show(pd.DataFrame(EDGES), source="from", target="to")
    # Nothing NumPy-shaped may be left in it, or the trait would fail to sync.
    assert json.loads(json.dumps(json.loads(widget.workspace))) == json.loads(widget.workspace)


def test_a_cell_opens_with_the_graph_and_nothing_else():
    widget = ngv.show(EDGES, source="from", target="to")
    # Not a window: the panels are behind labelled tabs on the stage's edges.
    assert widget.panels == []
    assert widget.theme == "auto"


def test_panels_and_theme_can_be_asked_for():
    widget = ngv.show(EDGES, source="from", target="to", panels=["table", "stats"], theme="dark")
    assert widget.panels == ["table", "stats"]
    assert widget.theme == "dark"


def test_a_panel_or_theme_that_does_not_exist_is_refused_here_rather_than_ignored_there():
    import traitlets

    with pytest.raises(traitlets.TraitError):
        ngv.show(EDGES, source="from", target="to", panels=["nonsense"])
    with pytest.raises(traitlets.TraitError):
        ngv.show(EDGES, source="from", target="to", theme="dusk")
