import { useMemo } from "react";
import type { Column, ColumnFilter, Row } from "../types";
import { columnRange, distinctValues } from "../lib/graph";
import { computeBins, numericValues } from "../lib/histogram";
import { Histogram } from "./Histogram";

interface ColumnConditionProps {
  rows: Row[];
  column: Column;
  value: ColumnFilter;
  /**
   * Rows to draw the range histogram over, when the caller can say what the
   * condition will actually be tested against: a chain step passes the rows
   * entering it. Left out, there is no histogram, just the inputs.
   */
  binRows?: Row[];
  onChange: (filter: ColumnFilter) => void;
}

const MAX_VALUE_ROWS = 40;

/**
 * The condition half of a column filter: checkboxes for categories, a range
 * for numbers. Shared by the filter chain and anything else that needs to
 * express "this column, these values".
 */
export function ColumnCondition({ rows, column, value, binRows, onChange }: ColumnConditionProps) {
  if (column.type === "number") {
    return (
      <RangeCondition
        rows={rows}
        column={column}
        value={value}
        binRows={binRows}
        onChange={onChange}
      />
    );
  }
  return <ValueCondition rows={rows} column={column} value={value} onChange={onChange} />;
}

function ValueCondition({ rows, column, value, onChange }: ColumnConditionProps) {
  const values = useMemo(() => distinctValues(rows, column.name), [rows, column]);
  const selected = value.kind === "values" ? new Set(value.selected) : new Set<string>();

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ kind: "values", selected: [...next] });
  };

  return (
    <>
      <div className="filter-links">
        <button
          type="button"
          onClick={() => onChange({ kind: "values", selected: values.map((v) => v.key) })}
        >
          All
        </button>
        <button type="button" onClick={() => onChange({ kind: "values", selected: [] })}>
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

function RangeCondition({ rows, column, value, binRows, onChange }: ColumnConditionProps) {
  const range = useMemo(() => columnRange(rows, column.name), [rows, column]);
  const current = value.kind === "range" ? value : { kind: "range" as const, min: null, max: null };

  const bins = useMemo(
    () => (binRows === undefined ? null : computeBins(numericValues(binRows, column.name))),
    [binRows, column.name],
  );

  const update = (part: "min" | "max", raw: string) => {
    const parsed = raw.trim() === "" ? null : Number(raw);
    onChange({ ...current, [part]: parsed !== null && isNaN(parsed) ? null : parsed });
  };

  return (
    <>
      {bins && (
        <Histogram
          bins={bins}
          min={current.min}
          max={current.max}
          label={column.name}
          onChange={(min, max) => onChange({ ...current, min, max })}
        />
      )}
      <div className="filter-range">
        <input
          type="number"
          placeholder={range ? String(range.min) : "min"}
          value={current.min ?? ""}
          onChange={(e) => update("min", e.target.value)}
          aria-label={`Minimum ${column.name}`}
        />
        <span>to</span>
        <input
          type="number"
          placeholder={range ? String(range.max) : "max"}
          value={current.max ?? ""}
          onChange={(e) => update("max", e.target.value)}
          aria-label={`Maximum ${column.name}`}
        />
      </div>
    </>
  );
}
