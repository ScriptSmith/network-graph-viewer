"""Turning Python data into the workspace the viewer opens.

A workspace is the app's own ``.ngv.json``: an edge table, a node table that
always exists, and the styling and layout wrapped around them. Building one
here rather than shipping a bespoke payload means the notebook goes in through
the same door as a dropped file or a shared link, and the same reader on the
other side.

Two things have to be true of everything that goes in. Every cell has to be a
string, a number, a boolean or nothing at all, because that is what a cell is;
NumPy scalars, timestamps and decimals each land as the nearest honest one.
And every column needs a type, taken from a DataFrame's dtype where there is
one and inferred from the values where there is not.
"""

from __future__ import annotations

import base64
import datetime
import decimal
import math
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

FORMAT = "network-graph-viewer"
VERSION = 1

DEFAULT_NODE_ID_COLUMN = "Id"

LAYOUTS = (
    "force",
    "forceatlas2",
    "hierarchy",
    "radial",
    "circle",
    "grid",
    "circlepack",
    "geo",
    "script",
)

# Past this an integer would not survive the trip through JSON's number type,
# and an id that rounds is an id that collides with its neighbour.
_MAX_SAFE = 2**53 - 1
_MIN_SAFE = -_MAX_SAFE

_BOOLEAN_WORDS = frozenset({"true", "false", "yes", "no"})

Cell = str | float | int | bool | None
Row = dict[str, Cell]


def _is_missing(value: Any) -> bool:
    """None, NaN, NaT and pandas' NA all mean the cell is empty."""
    if value is None:
        return True
    # Only asked of pandas if pandas is already loaded, which it must be for
    # any of its own missing values to be in hand.
    pandas = sys.modules.get("pandas")
    if pandas is not None:
        try:
            result = pandas.isna(value)
        except (TypeError, ValueError):
            return False
        return result if isinstance(result, bool) else False
    try:
        return bool(value != value)
    except (TypeError, ValueError):
        return False


def to_cell(value: Any) -> Cell:
    """A Python value as a cell.

    Anything the app cannot hold becomes the nearest thing it can, so nothing
    goes missing on the way to the table: an oversized integer keeps its digits
    as text, a timestamp becomes an ISO string, bytes become base64, and
    everything left over is asked for its ``str``.
    """
    if _is_missing(value):
        return None
    if isinstance(value, (str, bytes, bytearray)):
        pass  # Sequences with an .item() of their own; handled below.
    elif hasattr(value, "item"):
        # A NumPy scalar or a 0-d array carries a Python value inside it.
        try:
            value = value.item()
        except (AttributeError, TypeError, ValueError):
            pass
        if _is_missing(value):
            return None

    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if _MIN_SAFE <= value <= _MAX_SAFE else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        # Base64 rather than hex: the app already reads bare base64 as an
        # image, so a column of thumbnails works the moment it lands.
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, decimal.Decimal):
        return float(value) if value.is_finite() else None
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    return str(value)


def _dtype_type(dtype: Any) -> str | None:
    """The column type a dtype settles on its own, or None to go and look."""
    kind = getattr(dtype, "kind", None)
    if kind == "b":
        return "bool"
    if kind in ("i", "u", "f"):
        return "number"
    if kind in ("M", "m"):
        # A timestamp is a quantity to arithmetic and a label to a graph.
        return "text"
    return None


def infer_column_type(values: Iterable[Cell]) -> str:
    """Classify a column from its values, the same way the app does on import."""
    seen = numeric = boolean = 0
    for value in list(values)[:200]:
        if value is None or value == "":
            continue
        seen += 1
        if isinstance(value, bool):
            boolean += 1
            continue
        if isinstance(value, (int, float)):
            numeric += 1
            continue
        if isinstance(value, str):
            if value.strip().lower() in _BOOLEAN_WORDS:
                boolean += 1
            try:
                float(value)
            except ValueError:
                pass
            else:
                numeric += 1
    if seen == 0:
        return "text"
    if boolean == seen:
        return "bool"
    return "number" if numeric / seen >= 0.8 else "text"


COLUMN_ROLES = ("color", "size", "image", "url", "time")

_COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\(.*\))$")
_URL = re.compile(r"^https?://", re.IGNORECASE)
_IMAGE_URL = re.compile(r"\.(png|jpe?g|gif|webp|svg|avif)([?#]|$)", re.IGNORECASE)
_DATA_IMAGE = re.compile(r"^data:image/", re.IGNORECASE)


def infer_column_role(values: Iterable[Cell]) -> str | None:
    """What a text column's values are for, when they say so almost unanimously.

    The viewer runs the same kind of census on import. Deliberately strict,
    and narrower than the app's (named CSS colors need a browser to read):
    a wrong role is worse than none, since the role decides which affordances
    hang on every cell.
    """
    filled = colors = images = urls = 0
    for value in list(values)[:200]:
        if not isinstance(value, str) or value.strip() == "":
            continue
        text = value.strip()
        filled += 1
        if _COLOR.match(text):
            colors += 1
        elif _URL.match(text):
            if _IMAGE_URL.search(text):
                images += 1
            else:
                urls += 1
        elif _DATA_IMAGE.match(text):
            images += 1
    if filled < 2:
        return None
    if colors / filled >= 0.9:
        return "color"
    if images / filled >= 0.9:
        return "image"
    if (urls + images) / filled >= 0.9 and urls > images:
        return "url"
    return None


def _apply_roles(table: dict[str, Any]) -> dict[str, Any]:
    for column in table["columns"]:
        if column["type"] != "text" or "role" in column:
            continue
        role = infer_column_role(row.get(column["name"]) for row in table["rows"])
        if role is not None:
            column["role"] = role
    return table


def _is_dataframe(data: Any) -> bool:
    return hasattr(data, "columns") and hasattr(data, "to_dict") and hasattr(data, "dtypes")


def _is_networkx(data: Any) -> bool:
    return hasattr(data, "edges") and hasattr(data, "nodes") and hasattr(data, "adj")


def _object_column_type(cells: Sequence[Cell]) -> str:
    """The type of a column pandas could only call ``object``.

    Strings all the way down means text, whatever the strings look like: an
    object column holding ``"0071"`` holds a string, because pandas would have
    used an integer dtype if it held a number. Guessing from the digits here
    would drop the leading zeros off an id and collide it with its neighbour.
    Anything more mixed than that goes back to counting, as delimited text does.
    """
    present = [c for c in cells if c is not None and c != ""]
    if present and all(isinstance(c, str) for c in present):
        return "text"
    return infer_column_type(cells)


def _table_from_dataframe(frame: Any, name: str) -> dict[str, Any]:
    names = [str(c) for c in frame.columns]
    rows: list[Row] = [
        {str(key): to_cell(value) for key, value in record.items()}
        for record in frame.to_dict(orient="records")
    ]
    columns = []
    for original, display in zip(frame.columns, names, strict=True):
        cells = [row.get(display) for row in rows]
        kind = _dtype_type(frame.dtypes[original]) or _object_column_type(cells)
        columns.append({"name": display, "type": kind})
    return {"name": name, "columns": columns, "rows": rows}


def _table_from_records(records: Iterable[Mapping[str, Any]], name: str) -> dict[str, Any]:
    names: list[str] = []
    rows: list[Row] = []
    for record in records:
        row: Row = {}
        for key, value in record.items():
            key = str(key)
            if key not in names:
                names.append(key)
            row[key] = to_cell(value)
        rows.append(row)
    # Squared off after the fact: a later row may name a column the first did
    # not, and a ragged table is one the app would have to guess about.
    for row in rows:
        for column in names:
            row.setdefault(column, None)
    columns = [
        {"name": column, "type": infer_column_type([row[column] for row in rows])}
        for column in names
    ]
    return {"name": name, "columns": columns, "rows": rows}


def _table_from_pairs(
    pairs: Iterable[Sequence[Any]], name: str, source: str, target: str
) -> dict[str, Any]:
    records = []
    for pair in pairs:
        values = list(pair)
        if len(values) < 2:
            raise ValueError("An edge needs a source and a target.")
        record: dict[str, Any] = {source: values[0], target: values[1]}
        if len(values) > 2:
            record["weight"] = values[2]
        records.append(record)
    return _table_from_records(records, name)


def to_table(data: Any, name: str, *, source: str = "source", target: str = "target") -> dict:
    """Any of the shapes an edge list arrives in, as one table."""
    if _is_dataframe(data):
        return _apply_roles(_table_from_dataframe(data, name))
    items = list(data)
    if not items:
        raise ValueError("There are no rows to draw.")
    if isinstance(items[0], Mapping):
        return _apply_roles(_table_from_records(items, name))
    if isinstance(items[0], Sequence) and not isinstance(items[0], (str, bytes)):
        return _apply_roles(_table_from_pairs(items, name, source, target))
    raise TypeError(
        "Edges must be a DataFrame, a sequence of mappings, or a sequence of "
        f"(source, target) pairs; got a sequence of {type(items[0]).__name__}."
    )


def _cell_to_id(value: Cell) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def derive_nodes(edge_rows: Sequence[Row], source: str, target: str) -> dict[str, Any]:
    """The node table an edge list implies: one row per endpoint, in first-seen order."""
    seen: set[str] = set()
    rows: list[Row] = []
    for row in edge_rows:
        for end in (_cell_to_id(row.get(source)), _cell_to_id(row.get(target))):
            if end is not None and end not in seen:
                seen.add(end)
                rows.append({DEFAULT_NODE_ID_COLUMN: end})
    return {
        "name": "Nodes",
        "columns": [{"name": DEFAULT_NODE_ID_COLUMN, "type": "text"}],
        "rows": rows,
    }


def _reconcile(
    nodes: dict[str, Any], edge_rows: Sequence[Row], node_id: str, source: str, target: str
) -> None:
    """Give every endpoint a node row, so the canvas and the table agree on who exists."""
    known = {
        id_ for id_ in (_cell_to_id(row.get(node_id)) for row in nodes["rows"]) if id_ is not None
    }
    for row in edge_rows:
        for end in (_cell_to_id(row.get(source)), _cell_to_id(row.get(target))):
            if end is not None and end not in known:
                known.add(end)
                nodes["rows"].append({node_id: end})


def _guess_node_id(table: dict[str, Any]) -> str:
    hints = {"id", "name", "label", "node", "node id", "key"}
    for column in table["columns"]:
        if column["name"].lower() in hints:
            return column["name"]
    for column in table["columns"]:
        if column["type"] == "text":
            return column["name"]
    return table["columns"][0]["name"] if table["columns"] else DEFAULT_NODE_ID_COLUMN


def _from_networkx(graph: Any) -> tuple[Any, Any, str, str]:
    """A networkx graph as edge records and node records, attributes and all."""
    edges = [
        {"source": _cell_to_id(to_cell(u)), "target": _cell_to_id(to_cell(v)), **dict(data)}
        for u, v, data in graph.edges(data=True)
    ]
    nodes = [
        {DEFAULT_NODE_ID_COLUMN: _cell_to_id(to_cell(n)), **dict(data)}
        for n, data in graph.nodes(data=True)
    ]
    return edges, nodes, "source", "target"


def _style_token(value: str | None, *, default: str) -> str:
    """A column name as a style token, or a token that already is one."""
    if value is None:
        return default
    return value if ":" in value else f"column:{value}"


_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}$")


def _valid_type_block(
    value: Mapping[str, Any], *, number_key: str, string_keys: Sequence[str]
) -> dict[str, Any]:
    """A per-type override block, shape-checked the way the app checks it.

    Colors are held to '#rrggbb' because that is all that survives the app's
    own parsing; better a loud error here than a silently grey mark there.
    The node block's number is 'size' (a radius) and the edge block's is
    'width' (a stroke); both may pick their own hover details with 'attrs'.
    """
    column = value.get("column")
    styles = value.get("styles")
    if not isinstance(column, str) or not isinstance(styles, Mapping):
        raise ValueError("A type styles block needs a 'column' name and a 'styles' mapping.")
    out: dict[str, dict[str, Any]] = {}
    for key, raw in styles.items():
        if not isinstance(raw, Mapping):
            raise ValueError(f"type styles for {key!r} must be a mapping.")
        entry: dict[str, Any] = {}
        if "color" in raw:
            color = raw["color"]
            if not isinstance(color, str) or not _HEX_COLOR.fullmatch(color):
                raise ValueError(f"type style color for {key!r} must be '#rrggbb'.")
            entry["color"] = color
        if number_key in raw:
            number = raw[number_key]
            if isinstance(number, bool) or not isinstance(number, (int, float)):
                raise ValueError(f"type style {number_key} for {key!r} must be a number.")
            entry[number_key] = number
        for name in string_keys:
            if name in raw:
                text = raw[name]
                if not isinstance(text, str):
                    raise ValueError(f"type style {name} for {key!r} must be a string.")
                entry[name] = text
        if "attrs" in raw:
            attrs = raw["attrs"]
            if (
                not isinstance(attrs, Sequence)
                or isinstance(attrs, (str, bytes))
                or not all(isinstance(a, str) for a in attrs)
            ):
                raise ValueError(f"type style attrs for {key!r} must be a list of column names.")
            entry["attrs"] = list(attrs)
        if entry:
            out[str(key)] = entry
    return {"column": column, "styles": out}


def build_workspace(
    edges: Any,
    *,
    source: str | None = None,
    target: str | None = None,
    nodes: Any = None,
    node_id: str | None = None,
    node_attrs: Sequence[str] | None = None,
    roles: Mapping[str, str] | None = None,
    type_styles: Mapping[str, Any] | None = None,
    edge_type_styles: Mapping[str, Any] | None = None,
    name: str = "Graph",
    color: str | None = None,
    size: str | None = None,
    image: str | None = None,
    label: str | None = None,
    edge_color: str | None = None,
    edge_width: str | None = None,
    arrows: bool = True,
    spacing: float = 1.0,
    layout: str = "force",
    show_isolated: bool | None = None,
    positions: Mapping[str, Mapping[str, float]] | None = None,
    pinned: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Assemble a workspace the viewer can open.

    ``edges`` may be a DataFrame, a sequence of mappings, a sequence of
    ``(source, target)`` pairs, or a networkx graph, in which case the node
    attributes come along with it.

    The style's optional curve fields (``nodeSizeCurve``, ``nodeColorCurve``,
    ``edgeWidthCurve``) are not emitted here; they can be chosen in the app,
    and a workspace without them keeps each channel's default scale.
    """
    if layout not in LAYOUTS:
        raise ValueError(f"Unknown layout {layout!r}; expected one of {', '.join(LAYOUTS)}.")

    if _is_networkx(edges):
        if nodes is not None:
            raise TypeError("A networkx graph already carries its nodes; pass one or the other.")
        edges, nodes, guessed_source, guessed_target = _from_networkx(edges)
        source = source or guessed_source
        target = target or guessed_target

    edge_table = to_table(edges, "Edges", source=source or "source", target=target or "target")
    edge_columns = [c["name"] for c in edge_table["columns"]]
    if len(edge_columns) < 2:
        raise ValueError("An edge list needs at least two columns: a source and a target.")

    source = source or edge_columns[0]
    target = target or next((c for c in edge_columns if c != source), edge_columns[0])
    for role, column in (("source", source), ("target", target)):
        if column not in edge_columns:
            raise ValueError(
                f"No {role} column named {column!r}; the edge table has "
                f"{', '.join(repr(c) for c in edge_columns)}."
            )

    declared = nodes is not None
    if declared:
        node_table = to_table(nodes, "Nodes")
        node_id = node_id or _guess_node_id(node_table)
        if node_id not in [c["name"] for c in node_table["columns"]]:
            raise ValueError(f"No node id column named {node_id!r} in the node table.")
        _reconcile(node_table, edge_table["rows"], node_id, source, target)
    else:
        node_table = derive_nodes(edge_table["rows"], source, target)
        node_id = DEFAULT_NODE_ID_COLUMN

    if node_attrs is not None:
        node_columns = [c["name"] for c in node_table["columns"]]
        for column in node_attrs:
            if column not in node_columns:
                raise ValueError(
                    f"No node column named {column!r} for node_attrs; the node table has "
                    f"{', '.join(repr(c) for c in node_columns)}."
                )

    # Declared roles override the census, wherever the name matches.
    for column_name, role in (roles or {}).items():
        if role not in COLUMN_ROLES:
            raise ValueError(f"Unknown role {role!r}; expected one of {', '.join(COLUMN_ROLES)}.")
        matched = False
        for table in (edge_table, node_table):
            for column in table["columns"]:
                if column["name"] == column_name:
                    column["role"] = role
                    matched = True
        if not matched:
            raise ValueError(f"No column named {column_name!r} to give the {role!r} role.")

    return {
        "format": FORMAT,
        "version": VERSION,
        "doc": {
            "name": name,
            "edges": edge_table,
            "nodes": node_table,
            "nodeIdColumn": node_id,
            "mapping": {
                "source": source,
                "target": target,
                "attrs": [c for c in edge_columns if c not in (source, target)],
                # Absent means every node column; only a chosen set is written.
                **({} if node_attrs is None else {"nodeAttrs": list(node_attrs)}),
            },
            "nodesDeclared": declared,
        },
        "style": {
            "nodeColor": _style_token(color, default="none"),
            "nodeSize": _style_token(size, default="metric:degree"),
            "nodeImage": _style_token(image, default="none"),
            "nodeLabel": _style_token(label, default="none"),
            "edgeColor": _style_token(edge_color, default="uniform"),
            "edgeWidth": _style_token(edge_width, default="uniform"),
            "arrows": arrows,
            "spacing": spacing,
            **(
                {}
                if type_styles is None
                else {
                    "typeStyles": _valid_type_block(
                        type_styles, number_key="size", string_keys=("image", "labelColumn")
                    )
                }
            ),
            **(
                {}
                if edge_type_styles is None
                else {
                    "edgeTypeStyles": _valid_type_block(
                        edge_type_styles, number_key="width", string_keys=()
                    )
                }
            ),
        },
        "chain": [],
        "layout": layout,
        "layoutParams": {},
        "showIsolated": declared if show_isolated is None else show_isolated,
        "preventOverlap": False,
        "positions": {str(k): dict(v) for k, v in (positions or {}).items()},
        # Written the way the app writes it: only when something is pinned.
        **({} if not pinned else {"pinned": [str(p) for p in pinned]}),
    }
