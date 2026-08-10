import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CellValue, Column, ColumnRole, ColumnType, GraphDoc, Row, Table } from "../types";
import type { EditTarget } from "../lib/edit";
import { cellKey, parseCell } from "../lib/cells";
import { distinctsOf } from "../lib/stats";
import {
  compileReplace,
  duplicateColumn,
  fillColumn,
  renameValues,
  replaceFailed,
  replaceInColumn,
  replaceMatches,
  retypeColumn,
  retypeLosses,
  setColumnRole,
  type ReplaceSpec,
  type RowScope,
} from "../lib/bulk";

/**
 * Everything one column can have done to it in bulk, behind the pencil in its
 * header. The panel is a small stack of views rather than a wall of controls:
 * the list of what can be done, and then the one thing being done, with the
 * values of the column always in reach underneath.
 *
 * Editing values is scoped to the rows the filter chain kept, because that is
 * what the rest of the drawer means by "in view" and because a filter is how
 * you say which rows you meant. Every form says how many rows it is about to
 * change before it changes them.
 */

type View = "menu" | "rename" | "type" | "role" | "replace" | "fill" | "values";

const TYPES: { id: ColumnType; name: string }[] = [
  { id: "text", name: "Text" },
  { id: "number", name: "Number" },
  { id: "bool", name: "True/false" },
];

const ROLES: { id: ColumnRole | ""; name: string; blurb: string }[] = [
  { id: "", name: "Ordinary values", blurb: "Nothing special hangs on them" },
  { id: "color", name: "Colors", blurb: "Cells hold colors the marks can wear as written" },
  { id: "size", name: "Sizes", blurb: "Cells hold pixel sizes for the marks" },
  { id: "image", name: "Images", blurb: "Cells hold pictures, or links to them" },
  { id: "url", name: "Links", blurb: "Cells hold web addresses, shown as links" },
  { id: "time", name: "Time", blurb: "Cells hold moments; the timeline runs along them" },
];

/** Above this many distinct values the list gets a box to narrow it down. */
const FILTERABLE = 12;
const MAX_VALUES = 400;

export interface ColumnMenuProps {
  table: Table;
  target: EditTarget;
  column: Column;
  /** The graph is built out of this column, so it can be renamed but not removed. */
  structural: boolean;
  /** Values here are node ids: renaming two of them to one merges those nodes. */
  isNodeId: boolean;
  /** Rows the filter chain kept, which is what "in view" means everywhere else. */
  visible: ReadonlySet<Row>;
  onEdit: (label: string, update: (doc: GraphDoc) => GraphDoc) => void;
  onRenameColumn: (to: string) => void;
  onDeleteColumn: () => void;
  onClose: () => void;
}

export function ColumnMenu({
  table,
  target,
  column,
  structural,
  isNodeId,
  visible,
  onEdit,
  onRenameColumn,
  onDeleteColumn,
  onClose,
}: ColumnMenuProps) {
  const [view, setView] = useState<View>("menu");
  const [inViewOnly, setInViewOnly] = useState(true);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());

  const inView = useMemo(
    () => table.rows.reduce((n, row) => n + (visible.has(row) ? 1 : 0), 0),
    [table.rows, visible],
  );
  const scope: RowScope = inViewOnly ? visible : null;

  const apply = (label: string, update: (doc: GraphDoc) => GraphDoc) => {
    onEdit(label, update);
    onClose();
  };

  const back = () => setView("menu");

  if (view === "rename") {
    return (
      <Form
        title="Rename column"
        onBack={back}
        initial={column.name}
        label="New name"
        action="Rename"
        canApply={(value) =>
          value.trim() !== "" &&
          value.trim() !== column.name &&
          !table.columns.some((c) => c.name === value.trim())
        }
        note={(value) =>
          table.columns.some((c) => c.name === value.trim() && c.name !== column.name)
            ? "That name is already taken."
            : null
        }
        onApply={(value) => {
          onRenameColumn(value.trim());
          onClose();
        }}
      />
    );
  }

  if (view === "type") {
    return (
      <TypeForm
        table={table}
        column={column}
        onBack={back}
        onApply={(type) =>
          apply(`changing the type of "${column.name}"`, (doc) =>
            retypeColumn(doc, target, column.name, type),
          )
        }
      />
    );
  }

  if (view === "role") {
    return (
      <RoleForm
        column={column}
        onBack={back}
        onApply={(role) =>
          apply(
            `treating "${column.name}" as ${role === undefined ? "ordinary values" : ROLES.find((r) => r.id === role)?.name.toLowerCase()}`,
            (doc) => setColumnRole(doc, target, column.name, role),
          )
        }
      />
    );
  }

  if (view === "replace") {
    return (
      <ReplaceForm
        table={table}
        column={column}
        scope={scope}
        scopeControl={
          <ScopeCheck
            checked={inViewOnly}
            onChange={setInViewOnly}
            inView={inView}
            total={table.rows.length}
          />
        }
        onBack={back}
        onApply={(replacer) =>
          apply(`the find and replace on "${column.name}"`, (doc) =>
            replaceInColumn(doc, target, column.name, scope, replacer),
          )
        }
      />
    );
  }

  if (view === "fill") {
    return (
      <FillForm
        table={table}
        column={column}
        scope={scope}
        scopeControl={
          <ScopeCheck
            checked={inViewOnly}
            onChange={setInViewOnly}
            inView={inView}
            total={table.rows.length}
          />
        }
        onBack={back}
        onApply={(value, onlyBlanks) =>
          apply(`filling "${column.name}"`, (doc) =>
            fillColumn(doc, target, column.name, value, onlyBlanks, scope),
          )
        }
      />
    );
  }

  if (view === "values") {
    const chosen = [...picked];
    return (
      <Form
        title={`Rename ${chosen.length} value${chosen.length === 1 ? "" : "s"}`}
        onBack={back}
        initial={chosen.length === 1 ? chosen[0] : ""}
        label="New value"
        action={`Apply · ${countValues(table, column.name, scope, picked)} rows`}
        canApply={(value) => value.trim() !== ""}
        note={() =>
          isNodeId && chosen.length > 1
            ? "These nodes will be merged: the survivor keeps its own attributes and takes the rest's edges."
            : null
        }
        extra={
          <ScopeCheck
            checked={inViewOnly}
            onChange={setInViewOnly}
            inView={inView}
            total={table.rows.length}
          />
        }
        onApply={(value) => {
          const renames = new Map(chosen.map((from) => [from, value.trim()]));
          apply(`renaming ${chosen.length} value${chosen.length === 1 ? "" : "s"}`, (doc) =>
            renameValues(doc, target, column.name, renames, scope),
          );
        }}
      />
    );
  }

  return (
    <>
      <div className="cm-head">
        <span className="cm-title">{column.name}</span>
        <span className="cm-type">
          {TYPES.find((t) => t.id === column.type)?.name}
          {column.role !== undefined
            ? ` · ${ROLES.find((r) => r.id === column.role)?.name.toLowerCase()}`
            : ""}
        </span>
      </div>

      <div className="cm-list">
        <button type="button" onClick={() => setView("rename")}>
          Rename column…
        </button>
        <button
          type="button"
          onClick={() =>
            apply(`duplicating "${column.name}"`, (doc) =>
              duplicateColumn(doc, target, column.name),
            )
          }
        >
          Duplicate column
        </button>
        <button type="button" onClick={() => setView("type")}>
          Change type…
        </button>
        <button type="button" onClick={() => setView("role")}>
          Treat as…
        </button>
        <button
          type="button"
          disabled={structural}
          title={
            structural
              ? `The graph is built out of ${column.name}, so it cannot be removed`
              : undefined
          }
          onClick={() => {
            onDeleteColumn();
            onClose();
          }}
        >
          Delete column
        </button>
      </div>

      <div className="cm-sep" />

      <div className="cm-list">
        <button type="button" onClick={() => setView("replace")}>
          Find and replace…
        </button>
        <button type="button" onClick={() => setView("fill")}>
          Fill…
        </button>
      </div>

      <div className="cm-sep" />

      <Facets
        table={table}
        column={column}
        isNodeId={isNodeId}
        picked={picked}
        onPicked={setPicked}
        onRename={() => setView("values")}
      />
    </>
  );
}

/** How many rows in scope hold one of the chosen values. */
function countValues(
  table: Table,
  column: string,
  scope: RowScope,
  picked: ReadonlySet<string>,
): number {
  let n = 0;
  for (const row of table.rows) {
    if (scope !== null && !scope.has(row)) continue;
    if (picked.has(cellKey(row[column]))) n++;
  }
  return n;
}

function ScopeCheck({
  checked,
  onChange,
  inView,
  total,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  inView: number;
  total: number;
}) {
  return (
    <label className="cm-check" title="Leave the rows the filter chain removed as they are">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      In view only
      <span className="cm-count">
        {inView} of {total}
      </span>
    </label>
  );
}

/** The distinct values of the column, as something to tick and rename. */
function Facets({
  table,
  column,
  isNodeId,
  picked,
  onPicked,
  onRename,
}: {
  table: Table;
  column: Column;
  isNodeId: boolean;
  picked: ReadonlySet<string>;
  onPicked: (next: ReadonlySet<string>) => void;
  onRename: () => void;
}) {
  const [needle, setNeedle] = useState("");
  const values = useMemo(() => distinctsOf(table.rows, column.name), [table.rows, column.name]);
  const shown = useMemo(() => {
    const lowered = needle.trim().toLowerCase();
    const matching =
      lowered === "" ? values : values.filter((v) => v.key.toLowerCase().includes(lowered));
    return matching.slice(0, MAX_VALUES);
  }, [values, needle]);

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onPicked(next);
  };

  return (
    <div className="cm-facets">
      <div className="cm-facet-head">
        <span>Values</span>
        <span className="cm-count">{values.length}</span>
      </div>
      {values.length > FILTERABLE && (
        <input
          className="cm-input"
          type="search"
          placeholder="Narrow the list"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          aria-label={`Narrow the values of ${column.name}`}
        />
      )}
      <div className="cm-values">
        {shown.map(({ key, count }) => (
          <label key={key} className="check-item">
            <input type="checkbox" checked={picked.has(key)} onChange={() => toggle(key)} />
            <span className="check-name">{key === "" ? "(blank)" : key}</span>
            <span className="check-count">{count}</span>
          </label>
        ))}
        {shown.length === 0 && <p className="note">Nothing matches.</p>}
      </div>
      <button
        type="button"
        className="cm-apply"
        disabled={picked.size === 0}
        onClick={onRename}
        title={
          isNodeId
            ? "Renaming several ids to one merges those nodes"
            : "Give every ticked value the same new value"
        }
      >
        {picked.size === 0
          ? "Rename selected…"
          : `Rename ${picked.size} selected${isNodeId && picked.size > 1 ? " (merges)" : ""}…`}
      </button>
    </div>
  );
}

interface FormProps {
  title: string;
  onBack: () => void;
  initial: string;
  label: string;
  action: string;
  canApply: (value: string) => boolean;
  note?: (value: string) => string | null;
  extra?: ReactNode;
  onApply: (value: string) => void;
}

/** One field and a button: the shape most of these operations take. */
function Form({
  title,
  onBack,
  initial,
  label,
  action,
  canApply,
  note,
  extra,
  onApply,
}: FormProps) {
  const [value, setValue] = useState(initial);
  const ready = canApply(value);
  const message = note?.(value) ?? null;

  return (
    <>
      <FormHead title={title} onBack={onBack} />
      <label className="cm-label">
        {label}
        <input
          className="cm-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) onApply(value);
          }}
        />
      </label>
      {extra}
      {message && <p className="note">{message}</p>}
      <button type="button" className="cm-apply" disabled={!ready} onClick={() => onApply(value)}>
        {action}
      </button>
    </>
  );
}

function FormHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="cm-head">
      <button type="button" className="cm-back" onClick={onBack} aria-label="Back to the menu">
        ‹
      </button>
      <span className="cm-title">{title}</span>
    </div>
  );
}

function TypeForm({
  table,
  column,
  onBack,
  onApply,
}: {
  table: Table;
  column: Column;
  onBack: () => void;
  onApply: (type: ColumnType) => void;
}) {
  const [type, setType] = useState<ColumnType>(column.type);
  const losses = useMemo(
    () => (type === column.type ? 0 : retypeLosses(table, column.name, type)),
    [table, column, type],
  );

  return (
    <>
      <FormHead title="Change type" onBack={onBack} />
      <p className="note">
        The type is guessed once, at import. Everything downstream trusts it: which filter a column
        gets, how it exports, whether it can drive a size.
      </p>
      <div className="cm-radios">
        {TYPES.map((t) => (
          <label key={t.id} className="check-item">
            <input
              type="radio"
              name="column-type"
              checked={type === t.id}
              onChange={() => setType(t.id)}
            />
            <span className="check-name">{t.name}</span>
          </label>
        ))}
      </div>
      {losses > 0 && (
        <p className="note warn">
          {losses} cell{losses === 1 ? "" : "s"} cannot be read that way and will be emptied.
        </p>
      )}
      <button
        type="button"
        className="cm-apply"
        disabled={type === column.type}
        onClick={() => onApply(type)}
      >
        Change type
      </button>
    </>
  );
}

function RoleForm({
  column,
  onBack,
  onApply,
}: {
  column: Column;
  onBack: () => void;
  onApply: (role: ColumnRole | undefined) => void;
}) {
  const current = column.role ?? "";
  const [role, setRole] = useState<ColumnRole | "">(current);

  return (
    <>
      <FormHead title="Treat as" onBack={onBack} />
      <p className="note">
        Says what the values are for, without changing them: colors can paint the marks, links and
        images get their own rendering in the details panel. Nothing is ever fetched because of a
        role alone.
      </p>
      <div className="cm-radios">
        {ROLES.map((r) => (
          <label key={r.id} className="check-item" title={r.blurb}>
            <input
              type="radio"
              name="column-role"
              checked={role === r.id}
              onChange={() => setRole(r.id)}
            />
            <span className="check-name">{r.name}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        className="cm-apply"
        disabled={role === current}
        onClick={() => onApply(role === "" ? undefined : role)}
      >
        Apply
      </button>
    </>
  );
}

function ReplaceForm({
  table,
  column,
  scope,
  scopeControl,
  onBack,
  onApply,
}: {
  table: Table;
  column: Column;
  scope: RowScope;
  scopeControl: ReactNode;
  onBack: () => void;
  onApply: (replacer: (text: string) => string) => void;
}) {
  const [spec, setSpec] = useState<ReplaceSpec>({
    find: "",
    replace: "",
    regex: false,
    caseSensitive: false,
    wholeCell: false,
  });
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => findRef.current?.focus(), []);

  const patch = (part: Partial<ReplaceSpec>) => setSpec((s) => ({ ...s, ...part }));

  // An empty pattern matches between every character, which is never what
  // anyone means by find and replace, so it counts as nothing to do.
  const compiled = useMemo(
    () => (spec.find === "" ? null : compileReplace(spec)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [spec.find, spec.replace, spec.regex, spec.caseSensitive, spec.wholeCell],
  );
  const error = compiled !== null && replaceFailed(compiled) ? compiled.error : null;
  const replacer = compiled !== null && !replaceFailed(compiled) ? compiled : null;
  const hits = useMemo(
    () => (replacer === null ? 0 : replaceMatches(table, column.name, scope, replacer).length),
    [table, column.name, scope, replacer],
  );

  return (
    <>
      <FormHead title="Find and replace" onBack={onBack} />
      <label className="cm-label">
        Find
        <input
          ref={findRef}
          className="cm-input"
          value={spec.find}
          onChange={(e) => patch({ find: e.target.value })}
        />
      </label>
      <label className="cm-label">
        Replace with
        <input
          className="cm-input"
          value={spec.replace}
          onChange={(e) => patch({ replace: e.target.value })}
          placeholder={spec.regex ? "$1 for a captured group" : "Leave empty to clear"}
        />
      </label>
      <div className="cm-toggles">
        <label className="cm-check">
          <input
            type="checkbox"
            checked={spec.caseSensitive}
            onChange={(e) => patch({ caseSensitive: e.target.checked })}
          />
          Match case
        </label>
        <label className="cm-check">
          <input
            type="checkbox"
            checked={spec.wholeCell}
            onChange={(e) => patch({ wholeCell: e.target.checked })}
          />
          Whole cell
        </label>
        <label className="cm-check">
          <input
            type="checkbox"
            checked={spec.regex}
            onChange={(e) => patch({ regex: e.target.checked })}
          />
          Regular expression
        </label>
      </div>
      {scopeControl}
      {error && <p className="note warn">{error}</p>}
      <button
        type="button"
        className="cm-apply"
        disabled={replacer === null || hits === 0}
        onClick={() => replacer && onApply(replacer)}
      >
        {replacer === null ? "Replace" : `Replace in ${hits} row${hits === 1 ? "" : "s"}`}
      </button>
    </>
  );
}

function FillForm({
  table,
  column,
  scope,
  scopeControl,
  onBack,
  onApply,
}: {
  table: Table;
  column: Column;
  scope: RowScope;
  scopeControl: ReactNode;
  onBack: () => void;
  onApply: (value: CellValue, onlyBlanks: boolean) => void;
}) {
  const [raw, setRaw] = useState("");
  const [onlyBlanks, setOnlyBlanks] = useState(true);

  const hits = useMemo(() => {
    let n = 0;
    for (const row of table.rows) {
      if (scope !== null && !scope.has(row)) continue;
      if (!onlyBlanks || (row[column.name] ?? null) === null) n++;
    }
    return n;
  }, [table.rows, column.name, scope, onlyBlanks]);

  const value = parseCell(column.type, raw);

  return (
    <>
      <FormHead title="Fill" onBack={onBack} />
      <label className="cm-label">
        Value
        <input
          className="cm-input"
          autoFocus
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Leave empty to clear"
        />
      </label>
      <label className="cm-check">
        <input
          type="checkbox"
          checked={onlyBlanks}
          onChange={(e) => setOnlyBlanks(e.target.checked)}
        />
        Only the blanks
      </label>
      {scopeControl}
      <button
        type="button"
        className="cm-apply"
        disabled={hits === 0}
        onClick={() => onApply(value, onlyBlanks)}
      >
        Fill {hits} row{hits === 1 ? "" : "s"}
      </button>
    </>
  );
}
