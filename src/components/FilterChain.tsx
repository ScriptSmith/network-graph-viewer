import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { BaseGraph, GraphDoc, Row, Table } from "../types";
import {
  chainInputBefore,
  defaultStep,
  describeStep,
  FILTER_KINDS,
  isFilterStep,
  neutralCondition,
  newStepId,
  type ChainStepResult,
  type FilterSpec,
  type FilterStep,
} from "../lib/filter";
import { edgeStyleColumns } from "../lib/doc";
import { distinctValues } from "../lib/graph";
import { computeBins } from "../lib/histogram";
import { formatTime, timeColumns, timeValues } from "../lib/timeline";
import { ColumnCondition } from "./ColumnCondition";
import { Histogram } from "./Histogram";

interface FilterChainProps {
  doc: GraphDoc;
  chain: FilterStep[];
  results: ChainStepResult[];
  /** Node currently selected on the canvas, offered as an ego-network centre. */
  selectedId: string | null;
  /** The chain's own setting, so a step editor sees what the step sees. */
  showIsolated: boolean;
  /** Whether the pane is on screen; the histograms stand down while it is not. */
  active: boolean;
  onChange: (chain: FilterStep[]) => void;
}

/**
 * The subgraph entering one step, for its editor to draw a histogram over.
 * Keyed on the serialized prefix rather than the chain itself: the value the
 * brackets are writing lives on the step being edited, and a drag must not
 * recompute what feeds it on every frame. The prefix is read through
 * `useDeferredValue` on top of that, so a drag on an *earlier* step reshapes
 * this histogram between frames rather than inside them. `enabled` carries
 * the pane's visibility down: a histogram nobody can see costs nothing.
 */
function useChainInput(
  doc: GraphDoc,
  chain: FilterStep[],
  stepId: string,
  showIsolated: boolean,
  enabled: boolean,
): { graph: BaseGraph; rows: Row[] } | null {
  const prefixKey = useMemo(() => {
    const at = chain.findIndex((s) => s.id === stepId);
    return JSON.stringify(chain.slice(0, at === -1 ? 0 : at));
  }, [chain, stepId]);
  const settledKey = useDeferredValue(prefixKey);
  return useMemo(
    () => (enabled ? chainInputBefore(doc, chain, stepId, { showIsolated }) : null),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [doc, settledKey, stepId, showIsolated, enabled],
  );
}

/**
 * The saved-step library: reusable specs, user-level rather than part of the
 * workspace, the way saved scripts are. A spec is a step without its id and
 * enabled flag; both are minted fresh on insert, and the spec is run through
 * `isFilterStep` first, since storage is as writable as any other input.
 */
const SAVED_STEPS_KEY = "ngv.filterSteps";

interface SavedStep {
  name: string;
  spec: unknown;
}

function loadSavedSteps(): SavedStep[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_STEPS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SavedStep =>
        e !== null && typeof e === "object" && typeof (e as SavedStep).name === "string",
    );
  } catch {
    return [];
  }
}

export function FilterChain({
  doc,
  chain,
  results,
  selectedId,
  showIsolated,
  active,
  onChange,
}: FilterChainProps) {
  const [adding, setAdding] = useState(false);
  const [savedSteps, setSavedSteps] = useState<SavedStep[]>(loadSavedSteps);

  useEffect(() => {
    try {
      localStorage.setItem(SAVED_STEPS_KEY, JSON.stringify(savedSteps));
    } catch {
      // Storage may be unavailable; the chain still works, saves just don't keep.
    }
  }, [savedSteps]);

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

  const saveStep = (step: FilterStep) => {
    const { id: _id, enabled: _enabled, ...spec } = step;
    const name = describeStep(step);
    setSavedSteps((current) => [...current.filter((s) => s.name !== name), { name, spec }]);
  };

  const forgetSaved = (name: string) => {
    setSavedSteps((current) => current.filter((s) => s.name !== name));
  };

  // Saved is worn on the star, and the star is a toggle: a step whose
  // description matches a library entry shows filled, and clicking it again
  // takes the entry back out. Editing a saved step changes its description,
  // so the star empties, which is the honest reading: the library holds what
  // was saved, not what is on screen now.
  const savedNames = useMemo(() => new Set(savedSteps.map((s) => s.name)), [savedSteps]);

  // A saved step naming a column this document lacks inserts anyway and shows
  // the same degraded state a renamed-away column would; only a spec that is
  // not a step at all is refused.
  const addSaved = (entry: SavedStep) => {
    const candidate = {
      ...(typeof entry.spec === "object" && entry.spec !== null ? entry.spec : {}),
      id: newStepId(),
      enabled: true,
    };
    if (isFilterStep(candidate)) onChange([...chain, candidate]);
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
          const saved = savedNames.has(describeStep(step));
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
                    className={step.invert === true ? "chain-invert active" : "chain-invert"}
                    aria-pressed={step.invert === true}
                    onClick={() =>
                      update(step.id, { invert: step.invert === true ? undefined : true })
                    }
                    aria-label={`Invert ${describeStep(step)}`}
                    title="Keep what this step would drop"
                  >
                    not
                  </button>
                  <button
                    type="button"
                    className={saved ? "chain-save active" : "chain-save"}
                    aria-pressed={saved}
                    onClick={() => (saved ? forgetSaved(describeStep(step)) : saveStep(step))}
                    aria-label={
                      saved
                        ? `Forget the saved step ${describeStep(step)}`
                        : `Save ${describeStep(step)} for reuse`
                    }
                    title={
                      saved
                        ? "Saved for reuse; click to forget it"
                        : "Save this step for reuse on any document"
                    }
                  >
                    {saved ? "★" : "☆"}
                  </button>
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
                chain={chain}
                showIsolated={showIsolated}
                active={active}
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
          {savedSteps.length > 0 && (
            <>
              <p className="field-label chain-saved-head">Saved steps</p>
              {savedSteps.map((entry) => (
                <div key={entry.name} className="chain-saved-row">
                  <button
                    type="button"
                    className="chain-kind"
                    onClick={() => addSaved(entry)}
                    title="Add this saved step to the chain"
                  >
                    <strong>{entry.name}</strong>
                  </button>
                  <button
                    type="button"
                    className="chain-saved-forget"
                    aria-label={`Forget the saved step ${entry.name}`}
                    onClick={() => forgetSaved(entry.name)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </>
          )}
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
  chain,
  showIsolated,
  active,
  step,
  selectedId,
  onChange,
}: {
  doc: GraphDoc;
  chain: FilterStep[];
  showIsolated: boolean;
  active: boolean;
  step: FilterStep;
  selectedId: string | null;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  switch (step.kind) {
    case "column":
      return (
        <ColumnStep
          doc={doc}
          chain={chain}
          showIsolated={showIsolated}
          active={active}
          step={step}
          onChange={onChange}
        />
      );

    case "degree":
      return (
        <DegreeStep
          doc={doc}
          chain={chain}
          showIsolated={showIsolated}
          active={active}
          step={step}
          onChange={onChange}
        />
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
          <EgoWhere doc={doc} step={step} onChange={onChange} />
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

    case "timewindow":
      return (
        <TimewindowStep
          doc={doc}
          chain={chain}
          showIsolated={showIsolated}
          active={active}
          step={step}
          onChange={onChange}
        />
      );
  }
}

/** The time window's editor: a column, its histogram, and the two bounds. */
function TimewindowStep({
  doc,
  chain,
  showIsolated,
  active,
  step,
  onChange,
}: {
  doc: GraphDoc;
  chain: FilterStep[];
  showIsolated: boolean;
  active: boolean;
  step: Extract<FilterStep, { kind: "timewindow" }>;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  const options = useMemo(() => timeColumns(doc), [doc]);
  const input = useChainInput(doc, chain, step.id, showIsolated, active);
  const bins = useMemo(() => {
    if (!input) return null;
    const rows = step.table === "edges" ? input.rows : input.graph.nodes.map((n) => n.row);
    return computeBins(timeValues(rows, step.column));
  }, [input, step.table, step.column]);
  const chosen = options.find((o) => o.table === step.table && o.column === step.column);
  const dates = chosen?.dates ?? false;

  return (
    <div className="chain-body">
      <select
        className="control"
        value={`${step.table}:${step.column}`}
        onChange={(e) => {
          const picked = options.find((o) => `${o.table}:${o.column}` === e.target.value);
          if (picked) {
            onChange({ table: picked.table, column: picked.column, min: null, max: null });
          }
        }}
        aria-label="Time column"
      >
        {/* A column outside the offered list still names itself, whether it
            was renamed away or never read as a time axis here. */}
        {chosen === undefined && (
          <option value={`${step.table}:${step.column}`}>{step.column}</option>
        )}
        {options.map((o) => (
          <option key={`${o.table}:${o.column}`} value={`${o.table}:${o.column}`}>
            {o.column}
            {o.table === "nodes" ? " (nodes)" : ""}
          </option>
        ))}
      </select>
      {bins && (
        <Histogram
          bins={bins}
          min={step.min}
          max={step.max}
          label={step.column}
          onChange={(min, max) => onChange({ min, max })}
        />
      )}
      <div className="filter-range">
        <input
          type="number"
          value={step.min ?? ""}
          placeholder="min"
          onChange={(e) => onChange({ min: numberOrNull(e.target.value) })}
          aria-label={`Window start over ${step.column}`}
        />
        <span>to</span>
        <input
          type="number"
          value={step.max ?? ""}
          placeholder="max"
          onChange={(e) => onChange({ max: numberOrNull(e.target.value) })}
          aria-label={`Window end over ${step.column}`}
        />
      </div>
      {dates && (step.min !== null || step.max !== null) && bins && (
        <p className="note">
          {formatTime(step.min ?? bins.min, true)} to {formatTime(step.max ?? bins.max, true)}.
          Bounds are epoch milliseconds; the brackets above are the easier way to set them.
        </p>
      )}
    </div>
  );
}

/**
 * The ego step's edge constraint: only edges matching one of the ticked
 * values are walked. Choosing a column starts with every value ticked, so
 * turning the constraint on never blanks the canvas by itself.
 */
function EgoWhere({
  doc,
  step,
  onChange,
}: {
  doc: GraphDoc;
  step: Extract<FilterStep, { kind: "ego" }>;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  const columns = useMemo(() => edgeStyleColumns(doc).filter((c) => c.type === "text"), [doc]);
  const where = step.where;
  const values = useMemo(
    () => (where === undefined ? [] : distinctValues(doc.edges.rows, where.column)),
    [doc.edges.rows, where],
  );
  if (columns.length === 0) return null;

  const setColumn = (column: string) => {
    if (column === "") {
      onChange({ where: undefined });
      return;
    }
    onChange({
      where: { column, values: distinctValues(doc.edges.rows, column).map((v) => v.key) },
    });
  };

  const toggle = (key: string) => {
    if (where === undefined) return;
    const selected = where.values.includes(key)
      ? where.values.filter((v) => v !== key)
      : [...where.values, key];
    onChange({ where: { ...where, values: selected } });
  };

  return (
    <>
      <label className="field">
        <span className="field-label">Walk edges where</span>
        <select
          className="control"
          value={where?.column ?? ""}
          onChange={(e) => setColumn(e.target.value)}
        >
          <option value="">Any edge</option>
          {columns.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      </label>
      {where !== undefined && (
        <div className="cm-values chain-where-values">
          {values.slice(0, 50).map(({ key, count }) => (
            <label key={key} className="check-item">
              <input
                type="checkbox"
                checked={where.values.includes(key)}
                onChange={() => toggle(key)}
              />
              <span className="check-name">{key === "" ? "(blank)" : key}</span>
              <span className="check-count">{count}</span>
            </label>
          ))}
          {values.length > 50 && <p className="note">+{values.length - 50} more values</p>}
        </div>
      )}
    </>
  );
}

/** The degree step's editor: mode, a histogram of what enters it, the bounds. */
function DegreeStep({
  doc,
  chain,
  showIsolated,
  active,
  step,
  onChange,
}: {
  doc: GraphDoc;
  chain: FilterStep[];
  showIsolated: boolean;
  active: boolean;
  step: Extract<FilterStep, { kind: "degree" }>;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  // Degree is measured on the incoming subgraph, exactly the way the step
  // measures it, so the bars describe what the brackets will cut.
  const input = useChainInput(doc, chain, step.id, showIsolated, active);
  const bins = useMemo(() => {
    if (!input) return null;
    const values = input.graph.nodes.map((n) =>
      step.mode === "in" ? n.inDegree : step.mode === "out" ? n.outDegree : n.degree,
    );
    return computeBins(values);
  }, [input, step.mode]);

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
      {bins && (
        <Histogram
          bins={bins}
          min={step.min}
          max={step.max}
          label="degree"
          onChange={(min, max) => onChange({ min, max })}
        />
      )}
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
}

function ColumnStep({
  doc,
  chain,
  showIsolated,
  active,
  step,
  onChange,
}: {
  doc: GraphDoc;
  chain: FilterStep[];
  showIsolated: boolean;
  active: boolean;
  step: Extract<FilterStep, { kind: "column" }>;
  onChange: (patch: Partial<FilterStep>) => void;
}) {
  const table: Table = step.table === "edges" ? doc.edges : doc.nodes;
  const column = table.columns.find((c) => c.name === step.column) ?? table.columns[0];

  // Rows entering this step, which is what a range's histogram should draw:
  // an edge step sees the surviving edge rows, a node step the surviving
  // nodes' own rows. Only fetched for a numeric column, where there are bars
  // to draw at all.
  const input = useChainInput(
    doc,
    chain,
    step.id,
    showIsolated,
    active && column?.type === "number",
  );
  const binRows = useMemo(() => {
    if (!input) return undefined;
    return step.table === "edges" ? input.rows : input.graph.nodes.map((n) => n.row);
  }, [input, step.table]);

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
          binRows={binRows}
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
