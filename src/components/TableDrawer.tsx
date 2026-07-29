import { useMemo, useState } from "react";
import type { VisibilityState } from "@tanstack/react-table";
import type { CellValue, GraphDoc, Row } from "../types";
import type { EditTarget } from "../lib/edit";
import { cellToId } from "../lib/cells";
import type { PanelHandleProps } from "../usePanelSize";
import { DataTable, type Aggregation } from "./DataTable";

interface TableDrawerProps {
  doc: GraphDoc;
  /** Which table is showing. Controlled, so other panels can point at one. */
  target: EditTarget;
  onTargetChange: (target: EditTarget) => void;
  /** Edge rows the filter chain kept. */
  visibleRows: ReadonlySet<Row>;
  /** Node ids the filter chain kept. */
  visibleNodeIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  onEditCell: (target: EditTarget, rowIndex: number, column: string, value: CellValue) => void;
  onAddRow: (target: EditTarget) => void;
  onDeleteRow: (target: EditTarget, rowIndex: number) => void;
  /** The pane's height is the shell's business, the way the sidebar's is. */
  gripProps: PanelHandleProps;
}

const AGGREGATIONS: { id: Aggregation; name: string }[] = [
  { id: "count", name: "Count" },
  { id: "sum", name: "Sum" },
  { id: "avg", name: "Average" },
  { id: "min", name: "Minimum" },
  { id: "max", name: "Maximum" },
];

export function TableDrawer({
  doc,
  target,
  onTargetChange,
  visibleRows,
  visibleNodeIds,
  selectedId,
  onSelectNode,
  onEditCell,
  onAddRow,
  onDeleteRow,
  gripProps,
}: TableDrawerProps) {
  const [search, setSearch] = useState("");
  const [onlyVisible, setOnlyVisible] = useState(true);
  const [groupBy, setGroupBy] = useState("");
  const [aggregation, setAggregation] = useState<Aggregation>("count");
  const [visibility, setVisibility] = useState<Record<EditTarget, VisibilityState>>({
    nodes: {},
    edges: {},
  });
  const [columnsOpen, setColumnsOpen] = useState(false);
  // Where the last Add row landed, so the table can keep it in sight.
  const [addedIndex, setAddedIndex] = useState<number | null>(null);

  const table = target === "nodes" ? doc.nodes : doc.edges;
  const addedRow = addedIndex === null ? null : (table.rows[addedIndex] ?? null);

  // The node table has no Row identity in the chain result, so visibility is
  // resolved through the id column instead.
  const visible = useMemo(() => {
    if (target === "edges") return visibleRows;
    const set = new Set<Row>();
    for (const row of doc.nodes.rows) {
      const id = cellToId(row[doc.nodeIdColumn]);
      if (id !== null && visibleNodeIds.has(id)) set.add(row);
    }
    return set;
  }, [target, visibleRows, visibleNodeIds, doc]);

  const selectedRow = useMemo(() => {
    if (selectedId === null) return null;
    if (target === "nodes") {
      return doc.nodes.rows.find((r) => cellToId(r[doc.nodeIdColumn]) === selectedId) ?? null;
    }
    return (
      doc.edges.rows.find(
        (r) =>
          cellToId(r[doc.mapping.source]) === selectedId ||
          cellToId(r[doc.mapping.target]) === selectedId,
      ) ?? null
    );
  }, [selectedId, target, doc]);

  const handleSelectRow = (row: Row | null) => {
    if (row === null) return onSelectNode(null);
    const id =
      target === "nodes" ? cellToId(row[doc.nodeIdColumn]) : cellToId(row[doc.mapping.source]);
    onSelectNode(id);
  };

  // The added row is listed even when the filter chain dropped it, so it counts.
  const shownCount = onlyVisible
    ? visible.size + (addedRow && !visible.has(addedRow) ? 1 : 0)
    : table.rows.length;

  return (
    <section className="drawer" aria-label="Data table">
      <div className="drawer-grip" aria-label="Data table height" {...gripProps} />

      <header className="drawer-bar">
        <div className="drawer-tabs" role="tablist">
          {(["edges", "nodes"] as EditTarget[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={target === id}
              className={target === id ? "drawer-tab active" : "drawer-tab"}
              onClick={() => {
                onTargetChange(id);
                setGroupBy("");
                setAddedIndex(null);
              }}
            >
              {id === "edges" ? "Edges" : "Nodes"}
              <span className="drawer-tab-count">
                {id === "edges" ? doc.edges.rows.length : doc.nodes.rows.length}
              </span>
            </button>
          ))}
        </div>

        <input
          className="drawer-search"
          type="search"
          placeholder="Search all columns"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the table"
        />

        <label className="drawer-check" title="Hide rows the filter chain removed">
          <input
            type="checkbox"
            checked={onlyVisible}
            onChange={(e) => setOnlyVisible(e.target.checked)}
          />
          In view only
        </label>

        <select
          className="drawer-select"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          aria-label="Group rows by a column"
        >
          <option value="">No grouping</option>
          {table.columns.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>

        {groupBy && (
          <select
            className="drawer-select"
            value={aggregation}
            onChange={(e) => setAggregation(e.target.value as Aggregation)}
            aria-label="Aggregate grouped values"
          >
            {AGGREGATIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}

        <div className="drawer-columns">
          <button
            type="button"
            className="drawer-btn"
            onClick={() => setColumnsOpen((v) => !v)}
            aria-expanded={columnsOpen}
          >
            Columns
          </button>
          {columnsOpen && (
            <div className="drawer-menu">
              {table.columns.map((c) => (
                <label key={c.name} className="check-item">
                  <input
                    type="checkbox"
                    checked={visibility[target][c.name] !== false}
                    onChange={(e) =>
                      setVisibility((v) => ({
                        ...v,
                        [target]: { ...v[target], [c.name]: e.target.checked },
                      }))
                    }
                  />
                  <span className="check-name">{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="drawer-count">{shownCount} rows</span>

        <button
          type="button"
          className="drawer-btn"
          onClick={() => {
            // A row is always appended, so it lands at the current end.
            setAddedIndex(table.rows.length);
            onAddRow(target);
          }}
        >
          Add row
        </button>
      </header>

      <DataTable
        table={table}
        visible={visible}
        onlyVisible={onlyVisible}
        addedIndex={addedIndex}
        search={search}
        groupBy={groupBy}
        aggregation={aggregation}
        columnVisibility={visibility[target]}
        onColumnVisibilityChange={(next) => setVisibility((v) => ({ ...v, [target]: next }))}
        selectedRow={selectedRow}
        onSelectRow={handleSelectRow}
        onEditCell={(rowIndex, column, value) => onEditCell(target, rowIndex, column, value)}
        onDeleteRow={(rowIndex) => {
          // A delete shifts every index after it, so the pin can no longer be
          // trusted to point at the row it was set for.
          setAddedIndex(null);
          onDeleteRow(target, rowIndex);
        }}
      />
    </section>
  );
}
