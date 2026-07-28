import { useEffect, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CellValue, Column, Row, Table } from "../types";
import { asNumber } from "../lib/parse";
import { displayCell, formatNumber } from "../lib/format";

export type Aggregation = "count" | "sum" | "avg" | "min" | "max";

export interface DataTableProps {
  table: Table;
  /** Rows currently surviving the filter chain; others are dimmed or hidden. */
  visible: ReadonlySet<Row>;
  onlyVisible: boolean;
  /**
   * Index of the row the Add row button just created. A fresh row is blank, so
   * the filter chain and the search would both drop it; it stays listed anyway
   * until the next add, so the user can see what they made.
   */
  addedIndex: number | null;
  search: string;
  groupBy: string;
  aggregation: Aggregation;
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: (next: VisibilityState) => void;
  selectedRow: Row | null;
  onSelectRow: (row: Row | null) => void;
  onEditCell: (rowIndex: number, column: string, value: CellValue) => void;
  onDeleteRow: (rowIndex: number) => void;
}

const ROW_HEIGHT = 30;

/** Parse an edited cell back to the column's type so filters keep working. */
function parseCell(column: Column, raw: string): CellValue {
  if (raw.trim() === "") return null;
  if (column.type === "number") {
    const value = Number(raw);
    return isNaN(value) ? raw : value;
  }
  if (column.type === "bool") {
    const lowered = raw.trim().toLowerCase();
    if (["true", "yes", "1"].includes(lowered)) return true;
    if (["false", "no", "0"].includes(lowered)) return false;
  }
  return raw;
}

export function DataTable({
  table,
  visible,
  onlyVisible,
  addedIndex,
  search,
  groupBy,
  aggregation,
  columnVisibility,
  onColumnVisibilityChange,
  selectedRow,
  onSelectRow,
  onEditCell,
  onDeleteRow,
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editing, setEditing] = useState<{ row: Row; column: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The row's position in the document, which is what an edit needs.
  const indexOf = useMemo(() => new Map(table.rows.map((row, i) => [row, i])), [table]);

  // Tracked by index, not identity: editing a cell replaces the row object,
  // and the row has to stay pinned while it is being filled in.
  const added = addedIndex === null ? null : (table.rows[addedIndex] ?? null);

  const data = useMemo(
    () =>
      onlyVisible ? table.rows.filter((row) => visible.has(row) || row === added) : table.rows,
    [table.rows, visible, onlyVisible, added],
  );

  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      table.columns.map((column) => ({
        id: column.name,
        accessorFn: (row: Row) => row[column.name],
        header: column.name,
        enableGrouping: true,
        sortingFn: column.type === "number" ? "basic" : "alphanumeric",
      })),
    [table.columns],
  );

  const grouping = useMemo(() => (groupBy ? [groupBy] : []), [groupBy]);

  const tableInstance = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: search, grouping, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) =>
      onColumnVisibilityChange(typeof updater === "function" ? updater(columnVisibility) : updater),
    globalFilterFn: (row, _columnId, filterValue: string) => {
      if (row.original === added) return true;
      const needle = String(filterValue).toLowerCase();
      return table.columns.some((c) =>
        String(row.original[c.name] ?? "")
          .toLowerCase()
          .includes(needle),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    autoResetExpanded: false,
  });

  const rows = tableInstance.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Follow the canvas: selecting a node should bring its row into view.
  useEffect(() => {
    if (!selectedRow) return;
    const index = rows.findIndex((r) => r.original === selectedRow);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow, rows.length]);

  // A new row lands at the end of the table, which is rarely where the user is
  // looking, so scroll to it and open its first cell. Keyed on the index alone:
  // re-firing on every edit to the row would yank the cursor back.
  useEffect(() => {
    if (!added) return;
    const index = rows.findIndex((r) => r.original === added);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    const first = tableInstance.getVisibleLeafColumns()[0];
    if (first) setEditing({ row: added, column: first.id });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [addedIndex]);

  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length > 0 ? items[0].start : 0;
  const paddingBottom =
    items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;

  /**
   * Aggregates are computed here rather than through TanStack's aggregationFn:
   * the grouped row model is memoized on the grouping state, so swapping the
   * aggregation would not invalidate it and the old numbers would stick.
   */
  const aggregate = (leaves: Row[], column: Column): number | null => {
    if (aggregation === "count") return leaves.length;
    if (column.type !== "number") return null;
    const values = leaves
      .map((row) => asNumber(row[column.name]))
      .filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    if (aggregation === "sum") return values.reduce((a, b) => a + b, 0);
    if (aggregation === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
    if (aggregation === "min") return Math.min(...values);
    return Math.max(...values);
  };

  const commit = (row: Row, column: Column, raw: string) => {
    const index = indexOf.get(row);
    setEditing(null);
    if (index === undefined) return;
    const value = parseCell(column, raw);
    if (value !== (row[column.name] ?? null)) onEditCell(index, column.name, value);
  };

  return (
    <div className="dt" ref={scrollRef}>
      <table className="dt-table">
        <thead>
          {tableInstance.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              <th className="dt-gutter" />
              {headerGroup.headers.map((header) => (
                <th key={header.id}>
                  <button
                    type="button"
                    className="dt-sort"
                    onClick={header.column.getToggleSortingHandler()}
                    title={`Sort by ${header.column.id}`}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    <span className="dt-sort-mark">
                      {{ asc: "▲", desc: "▼" }[header.column.getIsSorted() as string] ?? ""}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr style={{ height: paddingTop }}>
              <td colSpan={tableInstance.getVisibleLeafColumns().length + 1} />
            </tr>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            const original = row.original;
            const dimmed = !onlyVisible && !visible.has(original);
            const isSelected = original === selectedRow;

            if (row.getIsGrouped()) {
              const leaves = row.getLeafRows().map((r) => r.original);
              return (
                <tr key={row.id} className="dt-group">
                  <td className="dt-gutter">
                    <button
                      type="button"
                      className="dt-expand"
                      onClick={row.getToggleExpandedHandler()}
                      aria-label={row.getIsExpanded() ? "Collapse group" : "Expand group"}
                    >
                      {row.getIsExpanded() ? "▾" : "▸"}
                    </button>
                  </td>
                  {row.getVisibleCells().map((cell) => {
                    const column = table.columns.find((c) => c.name === cell.column.id) as Column;
                    if (cell.getIsGrouped()) {
                      return (
                        <td key={cell.id}>
                          <strong>
                            {String(cell.getValue() ?? "(blank)")} ({leaves.length})
                          </strong>
                        </td>
                      );
                    }
                    // Only numeric columns carry a meaningful aggregate; the
                    // group header already says how many rows there are.
                    const value = aggregate(leaves, column);
                    return (
                      <td key={cell.id} className={column.type === "number" ? "dt-num" : undefined}>
                        {value === null ? null : (
                          <span className="dt-agg">{formatNumber(value)}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            }

            return (
              <tr
                key={row.id}
                className={[
                  "dt-row",
                  dimmed ? "dimmed" : "",
                  isSelected ? "selected" : "",
                  original === added ? "added" : "",
                ].join(" ")}
                onClick={() => onSelectRow(isSelected ? null : original)}
              >
                <td className="dt-gutter">
                  <button
                    type="button"
                    className="dt-delete"
                    title="Delete this row"
                    onClick={(e) => {
                      e.stopPropagation();
                      const index = indexOf.get(original);
                      if (index !== undefined) onDeleteRow(index);
                    }}
                  >
                    ×
                  </button>
                </td>
                {row.getVisibleCells().map((cell) => {
                  const column = table.columns.find((c) => c.name === cell.column.id) as Column;
                  const isEditing = editing?.row === original && editing.column === column.name;
                  return (
                    <td
                      key={cell.id}
                      className={column.type === "number" ? "dt-num" : undefined}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditing({ row: original, column: column.name });
                      }}
                    >
                      {isEditing ? (
                        <input
                          className="dt-input"
                          autoFocus
                          defaultValue={String(original[column.name] ?? "")}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => commit(original, column, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        displayCell(column, original[column.name])
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr style={{ height: paddingBottom }}>
              <td colSpan={tableInstance.getVisibleLeafColumns().length + 1} />
            </tr>
          )}
          {rows.length === 0 && (
            <tr>
              <td className="dt-empty" colSpan={tableInstance.getVisibleLeafColumns().length + 1}>
                Nothing to show.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
