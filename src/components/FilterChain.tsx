import { useMemo, useState } from "react";
import type { GraphDoc, Table } from "../types";
import {
  defaultStep,
  describeStep,
  FILTER_KINDS,
  neutralCondition,
  type ChainStepResult,
  type FilterSpec,
  type FilterStep,
} from "../lib/filter";
import { edgeStyleColumns } from "../lib/doc";
import { ColumnCondition } from "./ColumnCondition";

interface FilterChainProps {
  doc: GraphDoc;
  chain: FilterStep[];
  results: ChainStepResult[];
  /** Node currently selected on the canvas, offered as an ego-network centre. */
  selectedId: string | null;
  onChange: (chain: FilterStep[]) => void;
}

export function FilterChain({ doc, chain, results, selectedId, onChange }: FilterChainProps) {
  const [adding, setAdding] = useState(false);

  const resultFor = useMemo(() => new Map(results.map((r) => [r.id, r])), [results]);

  const update = (id: string, patch: Partial<FilterStep>) => {
    onChange(chain.map((s) => (s.id === id ? ({ ...s, ...patch } as FilterStep) : s)));
  };
  const remove = (id: string) => onChange(chain.filter((s) => s.id !== id));
  const move = (index: number, delta: number) => {
    const next = [...chain];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = (kind: FilterSpec["kind"]) => {
    onChange([...chain, defaultStep(kind, doc)]);
    setAdding(false);
  };

  return (
    <div className="chain">
      {chain.length === 0 && (
        <p className="note">
          No filters. Steps apply in order, each one narrowing what the next one sees.
        </p>
      )}

      <ol className="chain-list">
        {chain.map((step, index) => {
          const result = resultFor.get(step.id);
          return (
            <li key={step.id} className={step.enabled ? "chain-step" : "chain-step off"}>
              <div className="chain-head">
                <input
                  type="checkbox"
                  checked={step.enabled}
                  onChange={(e) => update(step.id, { enabled: e.target.checked })}
                  aria-label={`Enable ${describeStep(step)}`}
                />
                <span className="chain-name">{describeStep(step)}</span>
                <span className="chain-count">
                  {result ? `${result.nodes}n · ${result.links}e` : ""}
                </span>
                <span className="chain-actions">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move step earlier"
                    title="Move earlier"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === chain.length - 1}
                    aria-label="Move step later"
                    title="Move later"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(step.id)}
                    aria-label="Remove step"
                    title="Remove"
                  >
                    ×
                  </button>
                </span>
              </div>
              <StepBody
                doc={doc}
                step={step}
                selectedId={selectedId}
                onChange={(patch) => update(step.id, patch)}
              />
            </li>
          );
        })}
      </ol>

      {adding ? (
        <div className="chain-add">
          {FILTER_KINDS.map((k) => (
            <button key={k.kind} type="button" className="chain-kind" onClick={() => add(k.kind)}>
              <strong>{k.name}</strong>
              <span>{k.blurb}</span>
            </button>
          ))}
          <button type="button" className="btn btn-quiet" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            Add filter
          </button>
          {chain.length > 0 && (
            <button type="button" className="btn btn-quiet" onClick={() => onChange([])}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StepBody({
  doc,
  step,
  selectedId,
  onChange,
}: {
  doc: GraphDoc;
  step: FilterStep;
  selectedId: string | null;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  switch (step.kind) {
    case "column":
      return <ColumnStep doc={doc} step={step} onChange={onChange} />;

    case "degree":
      return (
        <div className="chain-body">
          <select
            className="control"
            value={step.mode}
            onChange={(e) => onChange({ mode: e.target.value as "all" | "in" | "out" })}
          >
            <option value="all">All connections</option>
            <option value="in">Incoming only</option>
            <option value="out">Outgoing only</option>
          </select>
          <div className="filter-range">
            <input
              type="number"
              value={step.min ?? ""}
              placeholder="min"
              onChange={(e) => onChange({ min: numberOrNull(e.target.value) })}
              aria-label="Minimum degree"
            />
            <span>to</span>
            <input
              type="number"
              value={step.max ?? ""}
              placeholder="max"
              onChange={(e) => onChange({ max: numberOrNull(e.target.value) })}
              aria-label="Maximum degree"
            />
          </div>
        </div>
      );

    case "kcore":
      return (
        <div className="chain-body">
          <label className="field">
            <span className="field-label">Keep the {step.k}-core and denser</span>
            <input
              type="range"
              className="range"
              min={1}
              max={12}
              step={1}
              value={step.k}
              onChange={(e) => onChange({ k: Number(e.target.value) })}
            />
          </label>
        </div>
      );

    case "component":
      return (
        <div className="chain-body">
          <label className="field">
            <span className="field-label">Keep the {step.count} largest</span>
            <input
              type="range"
              className="range"
              min={1}
              max={10}
              step={1}
              value={step.count}
              onChange={(e) => onChange({ count: Number(e.target.value) })}
            />
          </label>
        </div>
      );

    case "ego":
      return (
        <div className="chain-body">
          <div className="chain-centres">
            {step.centers.map((centre) => (
              <button
                key={centre}
                type="button"
                className="chain-chip"
                onClick={() => onChange({ centers: step.centers.filter((c) => c !== centre) })}
                title={`Remove ${centre}`}
              >
                {centre} ×
              </button>
            ))}
            {step.centers.length === 0 && <span className="note">No centre chosen.</span>}
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={selectedId === null || step.centers.includes(selectedId)}
            onClick={() => selectedId && onChange({ centers: [...step.centers, selectedId] })}
          >
            {selectedId ? `Add ${selectedId}` : "Select a node to add"}
          </button>
          <div className="chain-body-row">
            <label className="field">
              <span className="field-label">Depth {step.depth}</span>
              <input
                type="range"
                className="range"
                min={1}
                max={6}
                step={1}
                value={step.depth}
                onChange={(e) => onChange({ depth: Number(e.target.value) })}
              />
            </label>
            <select
              className="control"
              value={step.direction}
              onChange={(e) => onChange({ direction: e.target.value as "any" | "out" | "in" })}
            >
              <option value="any">Either direction</option>
              <option value="out">Follow arrows out</option>
              <option value="in">Follow arrows in</option>
            </select>
          </div>
        </div>
      );

    case "mutual":
      return (
        <div className="chain-body">
          <p className="note">Keeps only edges whose reverse edge also exists.</p>
        </div>
      );

    case "backbone":
      return <BackboneStep doc={doc} step={step} onChange={onChange} />;
  }
}

function ColumnStep({
  doc,
  step,
  onChange,
}: {
  doc: GraphDoc;
  step: Extract<FilterStep, { kind: "column" }>;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  const table: Table = step.table === "edges" ? doc.edges : doc.nodes;
  const column = table.columns.find((c) => c.name === step.column) ?? table.columns[0];

  const setColumn = (name: string) => {
    onChange({ column: name, op: neutralCondition(table, name) });
  };

  const setTable = (which: "nodes" | "edges") => {
    const target = which === "edges" ? doc.edges : doc.nodes;
    const first = target.columns[0]?.name ?? "";
    onChange({ table: which, column: first, op: neutralCondition(target, first) });
  };

  return (
    <div className="chain-body">
      <div className="chain-body-row">
        <select
          className="control"
          value={step.table}
          onChange={(e) => setTable(e.target.value as "nodes" | "edges")}
          aria-label="Table to filter"
        >
          <option value="edges">Edges</option>
          <option value="nodes">Nodes</option>
        </select>
        <select
          className="control"
          value={step.column}
          onChange={(e) => setColumn(e.target.value)}
          aria-label="Column to filter"
        >
          {table.columns.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      </div>
      {column && (
        <ColumnCondition
          rows={table.rows}
          column={column}
          value={step.op}
          onChange={(op) => onChange({ op })}
        />
      )}
    </div>
  );
}

function BackboneStep({
  doc,
  step,
  onChange,
}: {
  doc: GraphDoc;
  step: Extract<FilterStep, { kind: "backbone" }>;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  const weightColumns = useMemo(
    () => edgeStyleColumns(doc).filter((c) => c.type === "number"),
    [doc],
  );
  return (
    <div className="chain-body">
      <p className="note">
        Keeps edges that carry more weight than their endpoints' other edges can explain. Lower α is
        stricter.
      </p>
      <label className="field">
        <span className="field-label">α ≤ {step.alpha.toFixed(2)}</span>
        <input
          type="range"
          className="range"
          min={0.01}
          max={1}
          step={0.01}
          value={step.alpha}
          onChange={(e) => onChange({ alpha: Number(e.target.value) })}
        />
      </label>
      {weightColumns.length > 0 && (
        <select
          className="control"
          value={step.weightColumn ?? ""}
          onChange={(e) => onChange({ weightColumn: e.target.value || null })}
          aria-label="Weight column"
        >
          <option value="">Unweighted</option>
          {weightColumns.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function numberOrNull(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return isNaN(value) ? null : value;
}
