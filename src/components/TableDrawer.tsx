import { useCallback, useMemo, useRef, useState } from "react";
import type { VisibilityState } from "@tanstack/react-table";
import type { CellValue, ColumnFilter, GraphDoc, GraphSelection, Row } from "../types";
import type { EditTarget } from "../lib/edit";
import { cellToId } from "../lib/cells";
import { findColumnStep, narrows, newStepId, type FilterStep } from "../lib/filter";
import { downloadText, toCsv } from "../lib/io";
import type { PanelHandleProps } from "../usePanelSize";
import { DataTable, type Aggregation, type DataTableHandle, type RowTarget } from "./DataTable";

interface TableDrawerProps {
  doc: GraphDoc;
  /** Which table is showing. Controlled, so other panels can point at one. */
  target: EditTarget;
  onTargetChange: (target: EditTarget) => void;
  /** Edge rows the filter chain kept. */
  visibleRows: ReadonlySet<Row>;
  /** Node ids the filter chain kept. */
  visibleNodeIds: ReadonlySet<string>;
  selection: GraphSelection | null;
  onSelect: (next: GraphSelection | null) => void;
  /** The filter chain, which the column headers read and write directly. */
  chain: FilterStep[];
  onChainChange: (next: FilterStep[]) => void;
  onEditCell: (target: EditTarget, rowIndex: number, column: string, value: CellValue) => void;
  onAddRow: (target: EditTarget) => void;
  onDeleteRow: (target: EditTarget, rowIndex: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** What undo and redo would do, or null when they would do nothing. */
  undoLabel: string | null;
  redoLabel: string | null;
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
  selection,
  onSelect,
  chain,
  onChainChange,
  onEditCell,
  onAddRow,
  onDeleteRow,
  onUndo,
  onRedo,
  undoLabel,
  redoLabel,
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
  const [shownCount, setShownCount] = useState(0);
  const tableRef = useRef<DataTableHandle>(null);

  const table = target === "nodes" ? doc.nodes : doc.edges;

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

  /**
   * Every row the selection answers for. A link merges all the rows sharing its
   * endpoints, so an edge selection lights more than one; a node selection on
   * the edge table lights everything the node takes part in.
   */
  const selectedRows = useMemo(() => {
    const set = new Set<Row>();
    if (selection === null) return set;
    if (target === "nodes") {
      if (selection.kind !== "node") return set;
      for (const row of doc.nodes.rows) {
        if (cellToId(row[doc.nodeIdColumn]) === selection.id) set.add(row);
      }
      return set;
    }
    for (const row of doc.edges.rows) {
      const source = cellToId(row[doc.mapping.source]);
      const targetId = cellToId(row[doc.mapping.target]);
      if (selection.kind === "edge") {
        if (source === selection.source && targetId === selection.target) set.add(row);
      } else if (source === selection.id || targetId === selection.id) {
        set.add(row);
      }
    }
    return set;
  }, [selection, target, doc]);

  /** What a row stands for on the graph: a node here, an edge on the other tab. */
  const rowTarget = useCallback(
    (row: Row): RowTarget | null => {
      if (target === "nodes") {
        const id = cellToId(row[doc.nodeIdColumn]);
        return id === null ? null : { selection: { kind: "node", id }, label: id };
      }
      const source = cellToId(row[doc.mapping.source]);
      const targetId = cellToId(row[doc.mapping.target]);
      if (source === null || targetId === null) return null;
      return {
        selection: { kind: "edge", source, target: targetId },
        label: `${source} → ${targetId}`,
      };
    },
    [target, doc],
  );

  // On the edge table both endpoint cells name a node, so each carries its own
  // way of pointing at it; on the node table the gutter already says it once.
  const nodeColumns = useMemo(
    () => (target === "edges" ? [doc.mapping.source, doc.mapping.target] : []),
    [target, doc.mapping],
  );

  const columnFilter = useCallback(
    (column: string) => {
      const step = findColumnStep(chain, target, column);
      return step?.kind === "column" ? step.op : undefined;
    },
    [chain, target],
  );

  /**
   * A header condition is a chain step. Setting one adds or updates the step
   * the sidebar would have made, so both ends of the app are editing the same
   * filter rather than two that happen to agree.
   */
  const setColumnFilter = useCallback(
    (column: string, filter: ColumnFilter | null) => {
      const existing = findColumnStep(chain, target, column);
      if (filter === null) {
        if (existing) onChainChange(chain.filter((s) => s.id !== existing.id));
        return;
      }
      if (existing) {
        // Setting a condition on a step someone had switched off would look
        // like nothing happening, so it comes back on.
        onChainChange(
          chain.map((s) => (s.id === existing.id ? { ...s, op: filter, enabled: true } : s)),
        );
        return;
      }
      onChainChange([
        ...chain,
        { id: newStepId(), enabled: true, kind: "column", table: target, column, op: filter },
      ]);
    },
    [chain, target, onChainChange],
  );

  const filteredColumns = useMemo(() => {
    const names = new Set<string>();
    for (const step of chain) {
      if (step.kind !== "column" || step.table !== target || !step.enabled) continue;
      if (narrows(table.rows, step.column, step.op)) names.add(step.column);
    }
    return names;
  }, [chain, target, table.rows]);

  const clearColumnFilters = () => {
    onChainChange(chain.filter((s) => !(s.kind === "column" && s.table === target)));
  };

  /** Download what the table is showing, not what the document holds. */
  const downloadCsv = () => {
    const data = tableRef.current?.visibleData();
    if (!data) return;
    const base = doc.name.replace(/\.[^.]+$/, "") || "graph";
    downloadText({
      name: `${base}-${target}.csv`,
      mime: "text/csv",
      content: toCsv(data.columns, data.rows),
    });
  };

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

        {/* The browser's own clear cross is suppressed in the stylesheet, so
            the field looks the same everywhere and clears the same way. */}
        <div className="drawer-find">
          <input
            className="drawer-search"
            type="search"
            placeholder="Search all columns"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search the table"
          />
          {search !== "" && (
            <button
              type="button"
              className="drawer-search-clear"
              onClick={() => setSearch("")}
              title="Clear the search"
              aria-label="Clear the search"
            >
              ×
            </button>
          )}
        </div>

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

        {filteredColumns.size > 0 && (
          <button
            type="button"
            className="drawer-btn"
            title="Take this table's column steps back off the filter chain"
            onClick={clearColumnFilters}
          >
            Clear filters
            <span className="drawer-tab-count">{filteredColumns.size}</span>
          </button>
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
          onClick={downloadCsv}
          title="Download these rows and columns as a CSV"
        >
          CSV
        </button>

        {/* Undo covers every change to the document, not only the ones made
            here, so the pair sits with the buttons that make them. */}
        <div className="drawer-undo">
          <button
            type="button"
            className="drawer-btn"
            disabled={undoLabel === null}
            onClick={onUndo}
            title={undoLabel === null ? "Nothing to undo" : `Undo ${undoLabel}`}
            aria-label={undoLabel === null ? "Nothing to undo" : `Undo ${undoLabel}`}
          >
            <span aria-hidden="true">↶</span>
          </button>
          <button
            type="button"
            className="drawer-btn"
            disabled={redoLabel === null}
            onClick={onRedo}
            title={redoLabel === null ? "Nothing to redo" : `Redo ${redoLabel}`}
            aria-label={redoLabel === null ? "Nothing to redo" : `Redo ${redoLabel}`}
          >
            <span aria-hidden="true">↷</span>
          </button>
        </div>

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
        ref={tableRef}
        table={table}
        visible={visible}
        onlyVisible={onlyVisible}
        addedIndex={addedIndex}
        search={search}
        groupBy={groupBy}
        aggregation={aggregation}
        columnVisibility={visibility[target]}
        onColumnVisibilityChange={(next) => setVisibility((v) => ({ ...v, [target]: next }))}
        columnFilter={columnFilter}
        onColumnFilterChange={setColumnFilter}
        filteredColumns={filteredColumns}
        onShownCountChange={setShownCount}
        selection={selection}
        selectedRows={selectedRows}
        rowTarget={rowTarget}
        nodeColumns={nodeColumns}
        onSelect={onSelect}
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
