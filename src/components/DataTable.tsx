import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row as TanRow,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CellValue, Column, ColumnFilter, GraphSelection, Row, Table } from "../types";
import { nodeSelection, sameSelection } from "../types";
import { cellToId } from "../lib/cells";
import { asNumber } from "../lib/parse";
import { displayCell, formatNumber } from "../lib/format";
import { neutralCondition } from "../lib/filter";
import { ColumnCondition } from "./ColumnCondition";

export type Aggregation = "count" | "sum" | "avg" | "min" | "max";

/** What a row's gutter button points the graph at, and what to call it. */
export interface RowTarget {
  selection: GraphSelection;
  label: string;
}

export interface DataTableHandle {
  /** The columns and rows exactly as the table is showing them. */
  visibleData: () => { columns: string[]; rows: Row[] };
}

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
  /**
   * The filter-chain step a column header stands for. Header conditions are
   * chain steps, not a second set of filters, so setting one here is the same
   * act as adding one in the sidebar.
   */
  columnFilter: (column: string) => ColumnFilter | undefined;
  onColumnFilterChange: (column: string, filter: ColumnFilter | null) => void;
  /** Columns whose bound step is on and actually taking rows out. */
  filteredColumns: ReadonlySet<string>;
  /** How many rows survived everything, so the bar above can say so. */
  onShownCountChange: (count: number) => void;
  selection: GraphSelection | null;
  /** Rows the selection covers; one edge can answer for several of them. */
  selectedRows: ReadonlySet<Row>;
  /** What the gutter's select button on a row points at, or null for nothing. */
  rowTarget: (row: Row) => RowTarget | null;
  /** Columns whose cells hold a node id and so carry a select button. */
  nodeColumns: readonly string[];
  onSelect: (next: GraphSelection | null) => void;
  onEditCell: (rowIndex: number, column: string, value: CellValue) => void;
  onDeleteRow: (rowIndex: number) => void;
  ref?: Ref<DataTableHandle>;
}

const ROW_HEIGHT = 30;
const POPOVER_WIDTH = 232;

/** One line of the table: a row, or the rule that divides hits from the rest. */
type Item = { kind: "row"; row: TanRow<Row> } | { kind: "split"; matched: number; others: number };

interface Listing {
  items: Item[];
  /** How many rows matched the search, or -1 when nothing is being searched. */
  split: number;
}

const asItem = (row: TanRow<Row>): Item => ({ kind: "row", row });

/** A funnel, so a filtered column can't be mistaken for a sorted one. */
function FunnelIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M1 2h10l-4 4.2v4.3l-2-1.3V6.2z" fill="currentColor" />
    </svg>
  );
}

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
  columnFilter,
  onColumnFilterChange,
  filteredColumns,
  onShownCountChange,
  selection,
  selectedRows,
  rowTarget,
  nodeColumns,
  onSelect,
  onEditCell,
  onDeleteRow,
  ref,
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editing, setEditing] = useState<{ row: Row; column: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The row's position in the document, which is what an edit needs.
  const indexOf = useMemo(() => new Map(table.rows.map((row, i) => [row, i])), [table]);

  // Tracked by index, not identity: editing a cell replaces the row object,
  // and the row has to stay pinned while it is being filled in.
  const added = addedIndex === null ? null : (table.rows[addedIndex] ?? null);
  // Mirrored so the column definitions, which are built once per column set,
  // can still see which row is currently pinned.
  const addedRef = useRef<Row | null>(null);
  addedRef.current = added;

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
  const grouped = grouping.length > 0;
  const nodeCells = useMemo(() => new Set(nodeColumns), [nodeColumns]);

  const needle = search.trim().toLowerCase();
  const matches = useCallback(
    (row: Row) =>
      table.columns.some((c) =>
        String(row[c.name] ?? "")
          .toLowerCase()
          .includes(needle),
      ),
    [table.columns, needle],
  );

  // A header condition is a filter-chain step, so the rows it removes are
  // already gone from `visible` before the table sees them; there is nothing
  // here for the table's own column filtering to do.
  //
  // Searching takes rows nowhere: it lifts what matches to the top and leaves
  // the rest below, because looking for a row is not the same act as deciding
  // which rows belong. Grouping is the exception, since the group order is the
  // whole point of it and the aggregates have to count what the search kept.
  const tableInstance = useReactTable({
    data,
    columns,
    state: {
      sorting,
      globalFilter: grouped ? search : "",
      grouping,
      columnVisibility,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) =>
      onColumnVisibilityChange(typeof updater === "function" ? updater(columnVisibility) : updater),
    globalFilterFn: (row) => row.original === added || matches(row.original),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    autoResetExpanded: false,
  });

  const rows = tableInstance.getRowModel().rows;
  const shownCount = tableInstance.getFilteredRowModel().rows.length;

  /**
   * The rows in the order they are drawn. With a search running and no grouping
   * in the way, the hits come first and everything else follows behind a rule
   * saying how much was left there, so nothing goes missing while it is being
   * looked for. The user's sort still governs within each half.
   */
  const listing = useMemo<Listing>(() => {
    if (needle === "" || grouped) return { items: rows.map(asItem), split: -1 };
    const hits: TanRow<Row>[] = [];
    const rest: TanRow<Row>[] = [];
    for (const row of rows) (matches(row.original) ? hits : rest).push(row);
    const items: Item[] = hits.map(asItem);
    if (rest.length > 0) {
      items.push({ kind: "split", matched: hits.length, others: rest.length });
      items.push(...rest.map(asItem));
    }
    return { items, split: hits.length };
  }, [rows, needle, grouped, matches]);

  const items = listing.items;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    onShownCountChange(shownCount);
  }, [shownCount, onShownCountChange]);

  useImperativeHandle(ref, () => ({
    visibleData: () => ({
      columns: tableInstance.getVisibleLeafColumns().map((c) => c.id),
      // Grouping turns the sorted model into group headers, so a grouped table
      // hands back its leaves in document order rather than an order that no
      // longer exists. Everything else comes out in the order on screen, hits
      // of a running search included.
      rows: grouped
        ? tableInstance.getFilteredRowModel().rows.map((r) => r.original)
        : items.flatMap((i) => (i.kind === "row" ? [i.row.original] : [])),
    }),
  }));

  // Follow the canvas: a selection made out there should bring its first row
  // into view in here.
  useEffect(() => {
    if (selectedRows.size === 0) return;
    const index = items.findIndex((i) => i.kind === "row" && selectedRows.has(i.row.original));
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows, items.length]);

  // A new row lands at the end of the table, which is rarely where the user is
  // looking, so scroll to it and open its first cell. Keyed on the index alone:
  // re-firing on every edit to the row would yank the cursor back.
  useEffect(() => {
    if (!added) return;
    const index = items.findIndex((i) => i.kind === "row" && i.row.original === added);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    const first = tableInstance.getVisibleLeafColumns()[0];
    if (first) setEditing({ row: added, column: first.id });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [addedIndex]);

  const drawn = virtualizer.getVirtualItems();
  const paddingTop = drawn.length > 0 ? drawn[0].start : 0;
  const paddingBottom =
    drawn.length > 0 ? virtualizer.getTotalSize() - drawn[drawn.length - 1].end : 0;

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
              {headerGroup.headers.map((header) => {
                const column = table.columns.find((c) => c.name === header.column.id) as Column;
                return (
                  <th key={header.id}>
                    <div className="dt-head">
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
                      <HeaderFilter
                        table={table}
                        column={column}
                        value={columnFilter(column.name)}
                        active={filteredColumns.has(column.name)}
                        onChange={(filter) => onColumnFilterChange(column.name, filter)}
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr style={{ height: paddingTop }}>
              <td colSpan={tableInstance.getVisibleLeafColumns().length + 1} />
            </tr>
          )}
          {drawn.map((slot) => {
            const item = items[slot.index];
            if (item.kind === "split") {
              return (
                <tr key="split" className="dt-split">
                  <td colSpan={tableInstance.getVisibleLeafColumns().length + 1}>
                    {item.matched === 0
                      ? `Nothing matches · ${item.others} rows`
                      : `${item.matched} matching · ${item.others} others`}
                  </td>
                </tr>
              );
            }
            const row = item.row;
            const original = row.original;
            const dimmed = !onlyVisible && !visible.has(original);
            const unmatched = listing.split >= 0 && slot.index > listing.split;
            const isSelected = selectedRows.has(original);

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

            const target = rowTarget(original);
            const picked = target !== null && sameSelection(selection, target.selection);
            return (
              <tr
                key={row.id}
                className={[
                  "dt-row",
                  dimmed ? "dimmed" : "",
                  unmatched ? "unmatched" : "",
                  isSelected ? "selected" : "",
                  original === added ? "added" : "",
                ].join(" ")}
              >
                <td className="dt-gutter">
                  {/* Selecting is its own button, so a click anywhere else in
                      the row can go to reading or editing it. */}
                  <button
                    type="button"
                    className="dt-pick"
                    aria-pressed={picked}
                    disabled={target === null}
                    title={
                      target === null
                        ? "This row names nothing to select"
                        : picked
                          ? "Clear the selection"
                          : `Select ${target.label} in the graph`
                    }
                    onClick={() => onSelect(picked ? null : (target?.selection ?? null))}
                  >
                    ◎
                  </button>
                  <button
                    type="button"
                    className="dt-delete"
                    title="Delete this row"
                    onClick={() => {
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
                  const node = nodeCells.has(column.name) ? cellToId(original[column.name]) : null;
                  return (
                    <td
                      key={cell.id}
                      className={column.type === "number" ? "dt-num" : undefined}
                      onDoubleClick={() => setEditing({ row: original, column: column.name })}
                    >
                      {isEditing ? (
                        <input
                          className="dt-input"
                          autoFocus
                          defaultValue={String(original[column.name] ?? "")}
                          onBlur={(e) => commit(original, column, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : node === null ? (
                        displayCell(column, original[column.name])
                      ) : (
                        // An endpoint cell names a node, so it gets its own way
                        // of pointing at it: the gutter's button stands for the
                        // whole row, which on this table is the edge.
                        <span className="dt-node-cell">
                          <NodePick
                            id={node}
                            selected={selection?.kind === "node" && selection.id === node}
                            onSelect={onSelect}
                          />
                          <span className="dt-node-text">
                            {displayCell(column, original[column.name])}
                          </span>
                        </span>
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

function NodePick({
  id,
  selected,
  onSelect,
}: {
  id: string;
  selected: boolean;
  onSelect: (next: GraphSelection | null) => void;
}) {
  return (
    <button
      type="button"
      className="dt-pick dt-pick-cell"
      aria-pressed={selected}
      title={selected ? "Clear the selection" : `Select ${id} in the graph`}
      aria-label={selected ? "Clear the selection" : `Select ${id} in the graph`}
      onClick={() => onSelect(selected ? null : nodeSelection(id))}
    >
      ◎
    </button>
  );
}

interface HeaderFilterProps {
  table: Table;
  column: Column;
  value: ColumnFilter | undefined;
  active: boolean;
  onChange: (filter: ColumnFilter | null) => void;
}

/**
 * The funnel in a column header. The panel it opens is positioned against the
 * viewport rather than the header: the table scrolls in both directions inside
 * a pane that is often only a couple of rows tall, and a panel laid out inside
 * that pane would be clipped by it.
 */
function HeaderFilter({ table, column, value, active, onChange }: HeaderFilterProps) {
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Stable, so the panel's listeners are not torn down and put back on every
  // frame the virtualizer re-renders the table under it.
  const close = useCallback(() => setAnchor(null), []);

  /**
   * Follow the header rather than close with it. Ticking a value re-filters the
   * table underneath, which can scroll it, and a panel that shut every time the
   * thing it was filtering moved would be unusable.
   */
  const reanchor = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return setAnchor(null);
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)),
      // The table sits at the foot of the window, so the panel opens upwards.
      bottom: window.innerHeight - rect.top + 6,
    });
  }, []);

  const toggle = () => {
    if (anchor) setAnchor(null);
    else reanchor();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={active ? "dt-funnel on" : "dt-funnel"}
        aria-expanded={anchor !== null}
        title={active ? `Filtering on ${column.name}` : `Filter by ${column.name}`}
        aria-label={active ? `Filtering on ${column.name}` : `Filter by ${column.name}`}
        onClick={toggle}
      >
        <FunnelIcon />
      </button>
      {anchor && (
        <FilterPopover
          table={table}
          column={column}
          value={value}
          anchor={anchor}
          buttonRef={buttonRef}
          onChange={onChange}
          onClose={close}
          onReanchor={reanchor}
        />
      )}
    </>
  );
}

interface FilterPopoverProps extends Omit<HeaderFilterProps, "active"> {
  anchor: { left: number; bottom: number };
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onReanchor: () => void;
}

function FilterPopover({
  table,
  column,
  value,
  anchor,
  buttonRef,
  onChange,
  onClose,
  onReanchor,
}: FilterPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // With nothing set yet the panel starts from a condition that lets every row
  // through, so the first thing the user does is take something out.
  const condition = useMemo(
    () => value ?? neutralCondition(table, column.name),
    [value, table, column.name],
  );

  useEffect(() => {
    const dismiss = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Node)) return onClose();
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    // Capturing, so scrolling the table itself counts and the panel keeps up
    // with the header it belongs to rather than being left behind by it.
    window.addEventListener("scroll", onReanchor, true);
    window.addEventListener("resize", onReanchor);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onReanchor, true);
      window.removeEventListener("resize", onReanchor);
    };
  }, [buttonRef, onClose, onReanchor]);

  // Hung off the body rather than the header cell: the sticky header carries a
  // stacking context of its own, and inside it no z-index can lift the panel
  // over the buttons that ride the edges of the pane.
  return createPortal(
    <div
      ref={panelRef}
      className="dt-filter-pop"
      style={{ left: anchor.left, bottom: anchor.bottom, width: POPOVER_WIDTH }}
    >
      <div className="dt-filter-head">
        <span className="dt-filter-name">{column.name}</span>
        <button type="button" onClick={() => onChange(null)}>
          Clear
        </button>
      </div>
      <ColumnCondition
        rows={table.rows}
        column={column}
        value={condition}
        onChange={(filter) => onChange(filter)}
      />
    </div>,
    document.body,
  );
}
