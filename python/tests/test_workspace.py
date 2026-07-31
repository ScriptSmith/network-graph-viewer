import datetime
import decimal
import json
import pathlib

import networkx as nx
import pandas as pd
import pytest

from network_graph_viewer import build_workspace, to_cell, to_table

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "workspace.json"

EDGES = [
    {"from": "ana", "to": "ben", "weight": 3, "team": "design"},
    {"from": "ben", "to": "cleo", "weight": 1, "team": "design"},
    {"from": "cleo", "to": "ana", "weight": 4, "team": "research"},
]


def test_builds_a_workspace_from_records():
    workspace = build_workspace(EDGES, source="from", target="to", name="Team")

    assert workspace["format"] == "network-graph-viewer"
    assert workspace["version"] == 1
    doc = workspace["doc"]
    assert doc["name"] == "Team"
    assert doc["mapping"] == {"source": "from", "target": "to", "attrs": ["weight", "team"]}
    assert doc["nodesDeclared"] is False
    assert doc["nodeIdColumn"] == "Id"
    assert [c["name"] for c in doc["edges"]["columns"]] == ["from", "to", "weight", "team"]
    assert [c["type"] for c in doc["edges"]["columns"]] == ["text", "text", "number", "text"]


def test_derives_a_node_row_for_every_endpoint_once():
    doc = build_workspace(EDGES, source="from", target="to")["doc"]
    assert [row["Id"] for row in doc["nodes"]["rows"]] == ["ana", "ben", "cleo"]


def test_a_declared_node_table_keeps_its_attributes_and_gains_the_strangers():
    nodes = [{"Id": "ana", "dept": "design"}, {"Id": "zoe", "dept": "ops"}]
    doc = build_workspace(EDGES, source="from", target="to", nodes=nodes)["doc"]

    assert doc["nodesDeclared"] is True
    assert doc["nodeIdColumn"] == "Id"
    ids = [row["Id"] for row in doc["nodes"]["rows"]]
    # zoe is in no edge and survives; ben and cleo were named only by edges.
    assert ids == ["ana", "zoe", "ben", "cleo"]
    assert doc["nodes"]["rows"][0]["dept"] == "design"


def test_column_types_come_from_a_dataframe_dtype():
    frame = pd.DataFrame(
        {
            "from": ["0071", "0071"],
            "to": ["0042", "0500"],
            "weight": [1.5, 2.5],
            "active": [True, False],
            "seen": pd.to_datetime(["2024-03-01", "2024-03-02"]),
        }
    )
    doc = build_workspace(frame, source="from", target="to")["doc"]
    types = {c["name"]: c["type"] for c in doc["edges"]["columns"]}

    # Zero-padded ids stay text: a node id that loses its leading zeros
    # collides with its neighbour.
    assert types == {
        "from": "text",
        "to": "text",
        "weight": "number",
        "active": "bool",
        "seen": "text",
    }
    assert doc["edges"]["rows"][0]["seen"].startswith("2024-03-01")


def test_builds_from_pairs():
    doc = build_workspace([("a", "b"), ("b", "c")])["doc"]
    assert doc["mapping"]["source"] == "source"
    assert doc["mapping"]["target"] == "target"
    assert len(doc["edges"]["rows"]) == 2


def test_builds_from_networkx_with_attributes():
    graph = nx.DiGraph()
    graph.add_node("ana", dept="design")
    graph.add_node("ben", dept="research")
    graph.add_edge("ana", "ben", weight=2)

    doc = build_workspace(graph)["doc"]

    assert doc["nodesDeclared"] is True
    assert doc["edges"]["rows"] == [{"source": "ana", "target": "ben", "weight": 2}]
    assert {row["Id"]: row["dept"] for row in doc["nodes"]["rows"]} == {
        "ana": "design",
        "ben": "research",
    }


def test_style_names_a_column_or_takes_a_token_whole():
    workspace = build_workspace(EDGES, source="from", target="to", color="team")
    assert workspace["style"]["nodeColor"] == "column:team"

    workspace = build_workspace(EDGES, source="from", target="to", color="cell:team")
    assert workspace["style"]["nodeColor"] == "cell:team"

    workspace = build_workspace(EDGES, source="from", target="to")
    assert workspace["style"]["nodeColor"] == "none"
    assert workspace["style"]["nodeSize"] == "metric:degree"


def test_node_attrs_choose_the_hover_details_and_are_checked_by_name():
    nodes = [{"Id": "ana", "dept": "design", "seat": "4F"}]
    workspace = build_workspace(EDGES, source="from", target="to", nodes=nodes, node_attrs=["dept"])
    assert workspace["doc"]["mapping"]["nodeAttrs"] == ["dept"]

    workspace = build_workspace(EDGES, source="from", target="to", nodes=nodes)
    assert "nodeAttrs" not in workspace["doc"]["mapping"]

    with pytest.raises(ValueError, match="No node column named 'nope'"):
        build_workspace(EDGES, source="from", target="to", nodes=nodes, node_attrs=["nope"])


def test_a_column_of_colors_earns_the_color_role_and_prose_does_not():
    rows = [
        {"a": "x", "b": "y", "paint": "#b7410e", "note": "likes red"},
        {"a": "y", "b": "z", "paint": "#3987e5", "note": "red again"},
    ]
    table = build_workspace(rows, source="a", target="b")["doc"]["edges"]
    by_name = {c["name"]: c for c in table["columns"]}
    assert by_name["paint"]["role"] == "color"
    assert "role" not in by_name["note"]


def test_urls_and_image_urls_are_told_apart():
    rows = [
        {"a": "x", "b": "y", "site": "https://example.test/a", "pic": "https://example.test/a.png"},
        {"a": "y", "b": "z", "site": "https://example.test/b", "pic": "https://example.test/b.png"},
    ]
    table = build_workspace(rows, source="a", target="b")["doc"]["edges"]
    by_name = {c["name"]: c for c in table["columns"]}
    assert by_name["site"]["role"] == "url"
    assert by_name["pic"]["role"] == "image"


def test_declared_roles_override_and_are_checked():
    nodes = [{"Id": "ana", "swatch": "#fff"}]
    workspace = build_workspace(
        EDGES, source="from", target="to", nodes=nodes, roles={"team": "color"}
    )
    edge_columns = {c["name"]: c for c in workspace["doc"]["edges"]["columns"]}
    assert edge_columns["team"]["role"] == "color"

    with pytest.raises(ValueError, match="Unknown role"):
        build_workspace(EDGES, source="from", target="to", roles={"team": "flavour"})
    with pytest.raises(ValueError, match="No column named 'nope'"):
        build_workspace(EDGES, source="from", target="to", roles={"nope": "color"})


def test_type_styles_pass_through_shape_checked():
    workspace = build_workspace(
        EDGES,
        source="from",
        target="to",
        type_styles={
            "column": "team",
            "styles": {"design": {"color": "#e2762f", "size": 12, "attrs": ["weight"]}},
        },
        edge_type_styles={
            "column": "team",
            "styles": {"design": {"color": "#3f9f6e", "width": 4, "attrs": []}},
        },
    )
    assert workspace["style"]["typeStyles"] == {
        "column": "team",
        "styles": {"design": {"color": "#e2762f", "size": 12, "attrs": ["weight"]}},
    }
    assert workspace["style"]["edgeTypeStyles"] == {
        "column": "team",
        "styles": {"design": {"color": "#3f9f6e", "width": 4, "attrs": []}},
    }

    with pytest.raises(ValueError, match="must be '#rrggbb'"):
        build_workspace(
            EDGES,
            source="from",
            target="to",
            type_styles={"column": "team", "styles": {"design": {"color": "orange"}}},
        )
    with pytest.raises(ValueError, match="must be a list of column names"):
        build_workspace(
            EDGES,
            source="from",
            target="to",
            edge_type_styles={"column": "team", "styles": {"design": {"attrs": "weight"}}},
        )


def test_pinned_nodes_are_written_only_when_there_are_any():
    workspace = build_workspace(EDGES, source="from", target="to", pinned=["ana"])
    assert workspace["pinned"] == ["ana"]

    workspace = build_workspace(EDGES, source="from", target="to")
    assert "pinned" not in workspace


def test_a_label_column_becomes_the_node_label_token():
    nodes = [{"Id": "ana", "Name": "Ana Lopes"}]
    workspace = build_workspace(EDGES, source="from", target="to", nodes=nodes, label="Name")
    assert workspace["style"]["nodeLabel"] == "column:Name"

    workspace = build_workspace(EDGES, source="from", target="to")
    assert workspace["style"]["nodeLabel"] == "none"


def test_a_column_that_is_not_there_is_refused_by_name():
    with pytest.raises(ValueError, match="No source column named 'nope'"):
        build_workspace(EDGES, source="nope", target="to")


def test_an_unknown_layout_is_refused():
    with pytest.raises(ValueError, match="Unknown layout"):
        build_workspace(EDGES, source="from", target="to", layout="spiral")


def test_ragged_records_are_squared_off():
    table = to_table([{"a": 1}, {"a": 2, "b": 3}], "Edges")
    assert [c["name"] for c in table["columns"]] == ["a", "b"]
    assert table["rows"] == [{"a": 1, "b": None}, {"a": 2, "b": 3}]


class TestToCell:
    def test_keeps_the_digits_of_an_integer_too_large_to_be_a_number(self):
        assert to_cell(2**53) == "9007199254740992"
        assert to_cell(2**53 - 1) == 2**53 - 1

    def test_empty_values_all_come_out_as_nothing(self):
        assert to_cell(None) is None
        assert to_cell(float("nan")) is None
        assert to_cell(float("inf")) is None
        assert to_cell(pd.NA) is None
        assert to_cell(pd.NaT) is None

    def test_numpy_scalars_give_up_their_python_value(self):
        import numpy as np

        assert to_cell(np.int64(7)) == 7
        assert to_cell(np.float64(1.5)) == 1.5
        assert to_cell(np.bool_(True)) is True
        assert to_cell(np.float64("nan")) is None

    def test_shapes_a_cell_cannot_hold_become_text(self):
        assert to_cell(datetime.date(2024, 3, 1)) == "2024-03-01"
        assert to_cell(datetime.datetime(2024, 3, 1, 12, 30)) == "2024-03-01T12:30:00"
        assert to_cell(decimal.Decimal("1.25")) == 1.25
        assert to_cell(b"hi") == "aGk="
        assert to_cell(("a", "b")) == "('a', 'b')"

    def test_booleans_stay_booleans_rather_than_becoming_ones_and_zeros(self):
        assert to_cell(True) is True
        assert to_cell(False) is False


def test_the_committed_fixture_still_matches_what_we_build():
    """The JavaScript side reads this same file, so drift here breaks it there."""
    expected = json.loads(FIXTURE.read_text())
    assert build_workspace(EDGES, source="from", target="to", name="Team", color="team") == expected
