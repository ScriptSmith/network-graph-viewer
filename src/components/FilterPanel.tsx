import { useMemo } from "react";
import type { ColumnFilter, Filters, Sheet } from "../types";
import { columnRange, distinctValues } from "../lib/graph";
import { isNumericColumn } from "../lib/parse";

interface FilterPanelProps {
  sheet: Sheet;
  filters: Filters;
  onChange: (filters: Filters) => void;
}

const MAX_VALUE_ROWS = 40;

function ValueFilter({
  column,
  sheet,
  filter,
  onSet,
}: {
  column: string;
  sheet: Sheet;
  filter: ColumnFilter | undefined;
  onSet: (filter: ColumnFilter | null) => void;
}) {
  const values = useMemo(() => distinctValues(sheet.rows, column), [sheet, column]);
  const selected =
    filter?.kind === "values" ? new Set(filter.selected) : new Set(values.map((v) => v.key));

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    onSet(next.size === values.length ? null : { kind: "values", selected: [...next] });
  };

  return (
    <>
      <div className="filter-links">
        <button type="button" onClick={() => onSet(null)}>
          All
        </button>
        <button type="button" onClick={() => onSet({ kind: "values", selected: [] })}>
          None
        </button>
      </div>
      <div className="filter-values">
        {values.slice(0, MAX_VALUE_ROWS).map(({ key, count }) => (
          <label key={key} className="check-item">
            <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
            <span className="check-name">{key === "" ? "(blank)" : key}</span>
            <span className="check-count">{count}</span>
          </label>
        ))}
        {values.length > MAX_VALUE_ROWS && (
          <p className="note">+{values.length - MAX_VALUE_ROWS} more values not shown</p>
        )}
      </div>
    </>
  );
}

function RangeFilter({
  column,
  sheet,
  filter,
  onSet,
}: {
  column: string;
  sheet: Sheet;
  filter: ColumnFilter | undefined;
  onSet: (filter: ColumnFilter | null) => void;
}) {
  const range = useMemo(() => columnRange(sheet.rows, column), [sheet, column]);
  const current =
    filter?.kind === "range" ? filter : { kind: "range" as const, min: null, max: null };

  const update = (part: "min" | "max", raw: string) => {
    const value = raw.trim() === "" ? null : Number(raw);
    const next = { ...current, [part]: value !== null && isNaN(value) ? null : value };
    onSet(next.min === null && next.max === null ? null : next);
  };

  return (
    <div className="filter-range">
      <input
        type="number"
        placeholder={range ? String(range.min) : "min"}
        value={current.min ?? ""}
        onChange={(e) => update("min", e.target.value)}
        aria-label={`Minimum ${column}`}
      />
      <span>to</span>
      <input
        type="number"
        placeholder={range ? String(range.max) : "max"}
        value={current.max ?? ""}
        onChange={(e) => update("max", e.target.value)}
        aria-label={`Maximum ${column}`}
      />
    </div>
  );
}

function stateText(column: string, sheet: Sheet, filter: ColumnFilter | undefined): string | null {
  if (!filter) return null;
  if (filter.kind === "values") {
    const total = distinctValues(sheet.rows, column).length;
    return `${filter.selected.length}/${total}`;
  }
  const lo = filter.min ?? "";
  const hi = filter.max ?? "";
  return `${lo}–${hi}`;
}

export function FilterPanel({ sheet, filters, onChange }: FilterPanelProps) {
  const numeric = useMemo(
    () => new Set(sheet.columns.filter((c) => isNumericColumn(sheet.rows, c))),
    [sheet],
  );

  const setFilter = (column: string, filter: ColumnFilter | null) => {
    const next = { ...filters };
    if (filter === null) {
      delete next[column];
    } else {
      next[column] = filter;
    }
    onChange(next);
  };

  const activeCount = Object.keys(filters).length;

  return (
    <div className="filter-panel">
      {sheet.columns.map((column) => {
        const filter = filters[column];
        const state = stateText(column, sheet, filter);
        return (
          <details key={column} className="filter-col" open={filter !== undefined}>
            <summary>
              <span className="filter-name">{column}</span>
              <span className={state ? "filter-state active" : "filter-state"}>
                {state ?? "all"}
              </span>
            </summary>
            {numeric.has(column) ? (
              <RangeFilter
                column={column}
                sheet={sheet}
                filter={filter}
                onSet={(f) => setFilter(column, f)}
              />
            ) : (
              <ValueFilter
                column={column}
                sheet={sheet}
                filter={filter}
                onSet={(f) => setFilter(column, f)}
              />
            )}
          </details>
        );
      })}
      {activeCount > 0 && (
        <button type="button" className="btn btn-quiet" onClick={() => onChange({})}>
          Clear all filters
        </button>
      )}
    </div>
  );
}
