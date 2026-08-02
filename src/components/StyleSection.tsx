import { useMemo, type ReactNode } from "react";
import type {
  EdgeTypeStyle,
  GraphDoc,
  GraphStyle,
  LabelMode,
  Mapping,
  NodeTypeStyle,
  StyleCurve,
} from "../types";
import { isCellStyle, styleColumn } from "../types";
import { CELL_RADIUS, CELL_WIDTH, CENTRALITY_TOKENS, distinctValues } from "../lib/graph";
import {
  colorCellColumns,
  edgeStyleColumns,
  nodeDetailColumns,
  nodeStyleColumns,
} from "../lib/doc";

/**
 * The Style step, split the way the graph is: a Nodes group and an Edges
 * group. Each can name a type column, whose values become the kinds of thing
 * in the graph, and an "apply to" scope chooses whose rules are on screen:
 * the global ones, or one type's overrides of them. Every channel a type can
 * override lives in the same place the global rule does, so styling one kind
 * of node is the same act as styling all of them, just aimed.
 *
 * Overrides land on `style.typeStyles` / `style.edgeTypeStyles`, so they
 * travel with the workspace and undo like any other style change. Hover
 * details are the one channel that lives on the mapping instead, because
 * they choose columns of the document rather than a look.
 */

const MAX_TYPE_VALUES = 12;

const COLOR_CELL_NOTE =
  "Cells are painted as they read: #b7410e, #b41, rgb(183, 65, 14) or a color name. " +
  "Anything else stays grey, and the legend steps aside, the colors being their own key.";

/** The scope select's value for the global rules; type values ride behind a prefix. */
const GLOBAL_SCOPE = "global";
const typeScope = (value: string) => `type:${value}`;

interface ScopeSelectProps {
  /** null means the global rules. */
  scope: string | null;
  values: { key: string; count: number }[];
  /** Values carrying an override, marked in the list so they can be found. */
  styled: (key: string) => boolean;
  everyLabel: string;
  unit: string;
  onChange: (scope: string | null) => void;
}

function ScopeSelect({ scope, values, styled, everyLabel, unit, onChange }: ScopeSelectProps) {
  return (
    <label className="field">
      <span className="field-label">Apply to</span>
      <select
        className="control"
        value={scope === null ? GLOBAL_SCOPE : typeScope(scope)}
        onChange={(e) => onChange(e.target.value === GLOBAL_SCOPE ? null : e.target.value.slice(5))}
      >
        <option value={GLOBAL_SCOPE}>{everyLabel}</option>
        {values.slice(0, MAX_TYPE_VALUES).map(({ key, count }) => (
          <option key={key} value={typeScope(key)}>
            {key === "" ? "(blank)" : key} · {count} {count === 1 ? unit : `${unit}s`}
            {styled(key) ? " · styled" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One type's color: its own, or a swatch showing what the global rules gave it. */
function TypeColorField({
  name,
  color,
  fallback,
  onChange,
  onClear,
}: {
  name: string;
  color: string | undefined;
  fallback: string;
  onChange: (color: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="field">
      <span className="field-label">Color</span>
      <div className="ts-color-line">
        <input
          type="color"
          className="ts-color"
          value={color ?? fallback}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Color for ${name}`}
        />
        <span className="ts-color-note">
          {color !== undefined ? "its own" : "from the global rules"}
        </span>
        <button
          type="button"
          className="ts-clear"
          disabled={color === undefined}
          onClick={onClear}
          title="Back to the global color"
          aria-label={`Clear the color for ${name}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** The hover-details part: a type either shares the global set or picks its own. */
function AttrsEditor({
  attrs,
  candidates,
  fallback,
  onChange,
}: {
  attrs: string[] | undefined;
  candidates: string[];
  /** What "same as everywhere" currently means, used to seed a custom set. */
  fallback: string[];
  onChange: (attrs: string[] | undefined) => void;
}) {
  if (candidates.length === 0) return null;
  const custom = attrs !== undefined;
  return (
    <>
      <label className="check-item">
        <input
          type="checkbox"
          checked={custom}
          onChange={(e) => onChange(e.target.checked ? [...fallback] : undefined)}
        />
        <span className="check-name">Own hover details</span>
      </label>
      {custom && (
        <div className="ts-attrs">
          {candidates.map((name) => (
            <label key={name} className="check-item">
              <input
                type="checkbox"
                checked={attrs.includes(name)}
                onChange={() =>
                  onChange(
                    attrs.includes(name) ? attrs.filter((a) => a !== name) : [...attrs, name],
                  )
                }
              />
              <span className="check-name">{name}</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The interpolation for a numeric channel: linear, square root or log. Shown
 * only where a value is being mapped onto a scale; `cell:` tokens are literal
 * and uniform channels have nothing to curve. The fallback is what the channel
 * does with the field unset, so the select always shows the truth.
 */
function CurveSelect({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: StyleCurve | undefined;
  fallback: StyleCurve;
  onChange: (curve: StyleCurve) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        className="control"
        value={value ?? fallback}
        onChange={(e) => onChange(e.target.value as StyleCurve)}
      >
        <option value="linear">Linear</option>
        <option value="sqrt">Square root</option>
        <option value="log">Log</option>
      </select>
    </label>
  );
}

const emptyOverride = <T extends object>(o: T): boolean =>
  Object.values(o).every((v) => v === undefined);

/** Rebuild a styles record with one value's override rewritten or cleared. */
function withOverride<T extends object>(
  current: Record<string, T> | undefined,
  value: string,
  next: T | null,
): Record<string, T> {
  const styles = Object.create(null) as Record<string, T>;
  for (const [key, override] of Object.entries(current ?? {})) styles[key] = override;
  if (next === null || emptyOverride(next)) delete styles[value];
  else styles[value] = next;
  return styles;
}

function GroupShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="style-group">
      <h3 className="style-group-head">{title}</h3>
      {children}
    </div>
  );
}

/** The overflow note when a type column holds more values than are offered. */
function OverflowNote({ total }: { total: number }) {
  if (total <= MAX_TYPE_VALUES) return null;
  return <p className="note">+{total - MAX_TYPE_VALUES} more values keep the global rules.</p>;
}

export function NodeStyleSection({
  doc,
  style,
  colors,
  labelMode,
  chosenScope,
  onScopeChange,
  onStyleChange,
  onMappingChange,
  onLabelModeChange,
}: {
  doc: GraphDoc;
  style: GraphStyle;
  /** Color map in force, overrides included, so swatches match the marks. */
  colors: Map<string, string>;
  labelMode: LabelMode;
  /**
   * The "apply to" scope, held by the app so the schema view's pencil can
   * point this section at a type from outside. null is the global rules.
   */
  chosenScope: string | null;
  onScopeChange: (scope: string | null) => void;
  onStyleChange: (patch: Partial<GraphStyle>) => void;
  onMappingChange: (patch: Partial<Mapping>) => void;
  onLabelModeChange: (mode: LabelMode) => void;
}) {
  const setChosenScope = onScopeChange;
  const types = style.typeStyles;

  const styleColumns = useMemo(() => nodeStyleColumns(doc), [doc]);
  const numberColumns = useMemo(
    () => styleColumns.filter((c) => c.type === "number"),
    [styleColumns],
  );
  const colorColumns = useMemo(() => colorCellColumns(doc, "nodes"), [doc]);
  // Image references are text, whether they are links, data URIs or markup.
  const imageColumns = useMemo(() => styleColumns.filter((c) => c.type === "text"), [styleColumns]);
  // Columns whose role says they hold images lead the list under their own
  // heading; the rest stay offered, since a role is a hint rather than a gate.
  const imageRoleColumns = useMemo(
    () => imageColumns.filter((c) => c.role === "image"),
    [imageColumns],
  );
  const otherImageColumns = useMemo(
    () => imageColumns.filter((c) => c.role !== "image"),
    [imageColumns],
  );
  // Display names and type columns both live on the node table itself.
  const nodeTableColumns = useMemo(
    () => doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn),
    [doc],
  );
  const textColumns = useMemo(
    () => nodeTableColumns.filter((c) => c.type === "text").map((c) => c.name),
    [nodeTableColumns],
  );
  const detailCandidates = useMemo(() => nodeTableColumns.map((c) => c.name), [nodeTableColumns]);
  const globalAttrs = useMemo(() => nodeDetailColumns(doc).map((c) => c.name), [doc]);
  const values = useMemo(
    () => (types === undefined ? [] : distinctValues(doc.nodes.rows, types.column)),
    [doc.nodes.rows, types],
  );

  // The chosen scope can outlive the value it names (an edit, a new column);
  // rather than pointing at nothing it falls back to the global rules.
  const scope =
    types !== undefined &&
    chosenScope !== null &&
    values.slice(0, MAX_TYPE_VALUES).some((v) => v.key === chosenScope)
      ? chosenScope
      : null;

  const setColumn = (column: string | null) => {
    setChosenScope(null);
    if (column === null) {
      onStyleChange({ typeStyles: undefined });
      return;
    }
    onStyleChange({
      typeStyles: { column, styles: Object.create(null) as Record<string, NodeTypeStyle> },
      // Coloring by the type column is almost always what is meant, so an
      // unset color rule follows; one already chosen is left alone.
      ...(style.nodeColor === "none" ? { nodeColor: `column:${column}` } : {}),
    });
  };

  const update = (value: string, change: (current: NodeTypeStyle) => NodeTypeStyle | null) => {
    if (types === undefined) return;
    const current = Object.hasOwn(types.styles, value) ? types.styles[value] : {};
    onStyleChange({
      typeStyles: {
        column: types.column,
        styles: withOverride(types.styles, value, change(current)),
      },
    });
  };

  // The unchosen state means "all of them", so the first toggle materialises
  // the full set minus the one just unticked.
  const globalAttrSet = useMemo(() => new Set(globalAttrs), [globalAttrs]);
  const toggleGlobalAttr = (column: string) => {
    const nodeAttrs = globalAttrSet.has(column)
      ? [...globalAttrSet].filter((a) => a !== column)
      : [...globalAttrSet, column];
    onMappingChange({ nodeAttrs });
  };

  const override =
    types !== undefined && scope !== null && Object.hasOwn(types.styles, scope)
      ? types.styles[scope]
      : {};
  const scopeName = scope === "" ? "(blank)" : (scope ?? "");

  // The curve selects show only where a number is being mapped onto a scale.
  const colorCol = styleColumn(style.nodeColor);
  const colorNumeric =
    style.nodeColor in CENTRALITY_TOKENS ||
    (colorCol !== null &&
      !isCellStyle(style.nodeColor) &&
      numberColumns.some((c) => c.name === colorCol));
  const sizeNumeric = style.nodeSize !== "metric:uniform" && !isCellStyle(style.nodeSize);

  return (
    <GroupShell title="Nodes">
      {textColumns.length > 0 && (
        <label className="field">
          <span className="field-label">Type column</span>
          <select
            className="control"
            value={types?.column ?? ""}
            onChange={(e) => setColumn(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">None</option>
            {textColumns.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      )}
      {types === undefined && textColumns.length > 0 && (
        <p className="note">
          A type column makes its values kinds of node, each stylable on its own: color, size,
          image, label and hover details.
        </p>
      )}
      {types !== undefined && (
        <ScopeSelect
          scope={scope}
          values={values}
          styled={(key) => Object.hasOwn(types.styles, key) && !emptyOverride(types.styles[key])}
          everyLabel="Global · every node"
          unit="node"
          onChange={setChosenScope}
        />
      )}

      {scope === null ? (
        <>
          <label className="field">
            <span className="field-label">Color nodes by</span>
            <select
              className="control"
              value={style.nodeColor}
              onChange={(e) => onStyleChange({ nodeColor: e.target.value })}
            >
              <option value="none">None (single color)</option>
              <optgroup label="Rank by network metric">
                <option value="metric:degree">Connections (degree)</option>
                <option value="metric:betweenness">Betweenness centrality</option>
                <option value="metric:closeness">Closeness centrality</option>
                <option value="metric:eigenvector">Eigenvector centrality</option>
              </optgroup>
              <optgroup label="By column">
                {styleColumns.map((c) => (
                  <option key={c.name} value={`column:${c.name}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
              {colorColumns.length > 0 && (
                <optgroup label="Colors in the column">
                  {colorColumns.map((c) => (
                    <option key={c.name} value={`cell:${c.name}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {isCellStyle(style.nodeColor) && <p className="note">{COLOR_CELL_NOTE}</p>}
          {colorNumeric && (
            <CurveSelect
              label="Color scale"
              value={style.nodeColorCurve}
              fallback="linear"
              onChange={(nodeColorCurve) => onStyleChange({ nodeColorCurve })}
            />
          )}
          <label className="field">
            <span className="field-label">Size nodes by</span>
            <select
              className="control"
              value={style.nodeSize}
              onChange={(e) => onStyleChange({ nodeSize: e.target.value })}
            >
              <option value="metric:degree">Connections</option>
              <option value="metric:in">Incoming connections</option>
              <option value="metric:out">Outgoing connections</option>
              <option value="metric:uniform">Uniform</option>
              <optgroup label="Network metric">
                <option value="metric:betweenness">Betweenness centrality</option>
                <option value="metric:closeness">Closeness centrality</option>
                <option value="metric:eigenvector">Eigenvector centrality</option>
              </optgroup>
              <optgroup label="By number column">
                {numberColumns.map((c) => (
                  <option key={c.name} value={`column:${c.name}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
              {numberColumns.length > 0 && (
                <optgroup label="Pixel radius in the column">
                  {numberColumns.map((c) => (
                    <option key={c.name} value={`cell:${c.name}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {isCellStyle(style.nodeSize) && (
            <p className="note">
              Numbers are radii in pixels, held between {CELL_RADIUS.min} and {CELL_RADIUS.max}. A
              cell with no number in it keeps the plain size.
            </p>
          )}
          {sizeNumeric && (
            <CurveSelect
              label="Size scale"
              value={style.nodeSizeCurve}
              fallback="sqrt"
              onChange={(nodeSizeCurve) => onStyleChange({ nodeSizeCurve })}
            />
          )}
          <label className="field">
            <span className="field-label">Node images from</span>
            <select
              className="control"
              value={style.nodeImage}
              onChange={(e) => onStyleChange({ nodeImage: e.target.value })}
            >
              <option value="none">None</option>
              {imageRoleColumns.length > 0 ? (
                <>
                  <optgroup label="Image columns">
                    {imageRoleColumns.map((c) => (
                      <option key={c.name} value={`column:${c.name}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                  {otherImageColumns.length > 0 && (
                    <optgroup label="Other text columns">
                      {otherImageColumns.map((c) => (
                        <option key={c.name} value={`column:${c.name}`}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </>
              ) : (
                imageColumns.map((c) => (
                  <option key={c.name} value={`column:${c.name}`}>
                    {c.name}
                  </option>
                ))
              )}
            </select>
          </label>
          {style.nodeImage !== "none" && (
            <p className="note">
              Cells can hold an https link, a data URI, bare base64, or SVG markup. Linked images
              are fetched as the graph draws, so a PNG export leaves them out; embedded ones export
              with it.
            </p>
          )}
          {textColumns.length > 0 && (
            <label className="field">
              <span className="field-label">Label nodes with</span>
              <select
                className="control"
                value={style.nodeLabel}
                onChange={(e) => onStyleChange({ nodeLabel: e.target.value })}
              >
                <option value="none">Node id</option>
                {textColumns.map((name) => (
                  <option key={name} value={`column:${name}`}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">Labels</span>
            <select
              className="control"
              value={labelMode}
              onChange={(e) => onLabelModeChange(e.target.value as LabelMode)}
            >
              <option value="auto">Auto (declutter large graphs)</option>
              <option value="all">All nodes</option>
              <option value="none">None</option>
            </select>
          </label>
          {detailCandidates.length > 0 && (
            <fieldset className="check-list">
              <legend className="field-label">Details on hover</legend>
              {detailCandidates.map((name) => (
                <label key={name} className="check-item">
                  <input
                    type="checkbox"
                    checked={globalAttrSet.has(name)}
                    onChange={() => toggleGlobalAttr(name)}
                  />
                  <span className="check-name">{name}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      ) : (
        <div className="ts-scope">
          <TypeColorField
            name={scopeName}
            color={override.color}
            fallback={colors.get(scope) ?? "#888888"}
            onChange={(color) => update(scope, (o) => ({ ...o, color }))}
            onClear={() => update(scope, (o) => ({ ...o, color: undefined }))}
          />
          <label className="field">
            <span className="field-label">Radius (px)</span>
            <input
              type="number"
              className="ts-size"
              min={CELL_RADIUS.min}
              max={CELL_RADIUS.max}
              placeholder="auto"
              value={override.size ?? ""}
              onChange={(e) =>
                update(scope, (o) => ({
                  ...o,
                  size: e.target.value === "" ? undefined : Number(e.target.value),
                }))
              }
              aria-label={`Radius for ${scopeName}`}
            />
          </label>
          <label className="field">
            <span className="field-label">Image</span>
            <input
              className="cm-input"
              type="text"
              placeholder="https link, data URI or SVG markup"
              value={override.image ?? ""}
              onChange={(e) =>
                update(scope, (o) => ({
                  ...o,
                  image: e.target.value === "" ? undefined : e.target.value,
                }))
              }
              aria-label={`Image for ${scopeName}`}
            />
          </label>
          <label className="field">
            <span className="field-label">Label from</span>
            <select
              className="control"
              value={override.labelColumn ?? ""}
              onChange={(e) =>
                update(scope, (o) => ({
                  ...o,
                  labelColumn: e.target.value === "" ? undefined : e.target.value,
                }))
              }
            >
              <option value="">Whatever labels the rest</option>
              {textColumns.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <AttrsEditor
            attrs={override.attrs}
            candidates={detailCandidates}
            fallback={globalAttrs}
            onChange={(attrs) => update(scope, (o) => ({ ...o, attrs }))}
          />
          <button
            type="button"
            className="btn btn-quiet ts-reset"
            disabled={emptyOverride(override)}
            onClick={() => update(scope, () => null)}
          >
            Give {scopeName} back to the global rules
          </button>
        </div>
      )}
      {types !== undefined && <OverflowNote total={values.length} />}
    </GroupShell>
  );
}

export function EdgeStyleSection({
  doc,
  style,
  edgeColors,
  chosenScope,
  onScopeChange,
  onStyleChange,
  onMappingChange,
}: {
  doc: GraphDoc;
  style: GraphStyle;
  edgeColors: Map<string, string>;
  /** See `NodeStyleSection`: the scope lives with the app. */
  chosenScope: string | null;
  onScopeChange: (scope: string | null) => void;
  onStyleChange: (patch: Partial<GraphStyle>) => void;
  onMappingChange: (patch: Partial<Mapping>) => void;
}) {
  const setChosenScope = onScopeChange;
  const types = style.edgeTypeStyles;

  const styleColumns = useMemo(() => edgeStyleColumns(doc), [doc]);
  const numberColumns = useMemo(
    () => styleColumns.filter((c) => c.type === "number"),
    [styleColumns],
  );
  const colorColumns = useMemo(() => colorCellColumns(doc, "edges"), [doc]);
  const textColumns = useMemo(
    () => styleColumns.filter((c) => c.type === "text").map((c) => c.name),
    [styleColumns],
  );
  const detailCandidates = useMemo(() => styleColumns.map((c) => c.name), [styleColumns]);
  const values = useMemo(
    () => (types === undefined ? [] : distinctValues(doc.edges.rows, types.column)),
    [doc.edges.rows, types],
  );

  const scope =
    types !== undefined &&
    chosenScope !== null &&
    values.slice(0, MAX_TYPE_VALUES).some((v) => v.key === chosenScope)
      ? chosenScope
      : null;

  const setColumn = (column: string | null) => {
    setChosenScope(null);
    if (column === null) {
      onStyleChange({ edgeTypeStyles: undefined });
      return;
    }
    onStyleChange({
      edgeTypeStyles: { column, styles: Object.create(null) as Record<string, EdgeTypeStyle> },
      ...(style.edgeColor === "uniform" ? { edgeColor: `column:${column}` } : {}),
    });
  };

  const update = (value: string, change: (current: EdgeTypeStyle) => EdgeTypeStyle | null) => {
    if (types === undefined) return;
    const current = Object.hasOwn(types.styles, value) ? types.styles[value] : {};
    onStyleChange({
      edgeTypeStyles: {
        column: types.column,
        styles: withOverride(types.styles, value, change(current)),
      },
    });
  };

  const toggleGlobalAttr = (column: string) => {
    const attrs = doc.mapping.attrs.includes(column)
      ? doc.mapping.attrs.filter((a) => a !== column)
      : [...doc.mapping.attrs, column];
    onMappingChange({ attrs });
  };

  const override =
    types !== undefined && scope !== null && Object.hasOwn(types.styles, scope)
      ? types.styles[scope]
      : {};
  const scopeName = scope === "" ? "(blank)" : (scope ?? "");

  return (
    <GroupShell title="Edges">
      {textColumns.length > 0 && (
        <label className="field">
          <span className="field-label">Type column</span>
          <select
            className="control"
            value={types?.column ?? ""}
            onChange={(e) => setColumn(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">None</option>
            {textColumns.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      )}
      {types !== undefined && (
        <ScopeSelect
          scope={scope}
          values={values}
          styled={(key) => Object.hasOwn(types.styles, key) && !emptyOverride(types.styles[key])}
          everyLabel="Global · every edge"
          unit="row"
          onChange={setChosenScope}
        />
      )}

      {scope === null ? (
        <>
          <label className="field">
            <span className="field-label">Color edges by</span>
            <select
              className="control"
              value={style.edgeColor}
              onChange={(e) => onStyleChange({ edgeColor: e.target.value })}
            >
              <option value="uniform">Uniform</option>
              {styleColumns
                .filter((c) => c.type !== "number")
                .map((c) => (
                  <option key={c.name} value={`column:${c.name}`}>
                    {c.name}
                  </option>
                ))}
              {colorColumns.length > 0 && (
                <optgroup label="Colors in the column">
                  {colorColumns.map((c) => (
                    <option key={c.name} value={`cell:${c.name}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {isCellStyle(style.edgeColor) && <p className="note">{COLOR_CELL_NOTE}</p>}
          <label className="field">
            <span className="field-label">Edge width from</span>
            <select
              className="control"
              value={style.edgeWidth}
              onChange={(e) => onStyleChange({ edgeWidth: e.target.value })}
            >
              <option value="uniform">Uniform width</option>
              {numberColumns.map((c) => (
                <option key={c.name} value={`column:${c.name}`}>
                  {c.name}
                </option>
              ))}
              {numberColumns.length > 0 && (
                <optgroup label="Pixel width in the column">
                  {numberColumns.map((c) => (
                    <option key={c.name} value={`cell:${c.name}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {isCellStyle(style.edgeWidth) && (
            <p className="note">
              Numbers are stroke widths in pixels, held between {CELL_WIDTH.min} and{" "}
              {CELL_WIDTH.max}.
            </p>
          )}
          {style.edgeWidth.startsWith("column:") && (
            <CurveSelect
              label="Width scale"
              value={style.edgeWidthCurve}
              fallback="sqrt"
              onChange={(edgeWidthCurve) => onStyleChange({ edgeWidthCurve })}
            />
          )}
          <label className="check-item">
            <input
              type="checkbox"
              checked={style.arrows}
              onChange={(e) => onStyleChange({ arrows: e.target.checked })}
            />
            <span className="check-name">Direction arrows</span>
          </label>
          {detailCandidates.length > 0 && (
            <fieldset className="check-list">
              <legend className="field-label">Details on hover</legend>
              {detailCandidates.map((name) => (
                <label key={name} className="check-item">
                  <input
                    type="checkbox"
                    checked={doc.mapping.attrs.includes(name)}
                    onChange={() => toggleGlobalAttr(name)}
                  />
                  <span className="check-name">{name}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      ) : (
        <div className="ts-scope">
          <TypeColorField
            name={scopeName}
            color={override.color}
            fallback={edgeColors.get(scope) ?? "#888888"}
            onChange={(color) => update(scope, (o) => ({ ...o, color }))}
            onClear={() => update(scope, (o) => ({ ...o, color: undefined }))}
          />
          <label className="field">
            <span className="field-label">Stroke width (px)</span>
            <input
              type="number"
              className="ts-size"
              min={CELL_WIDTH.min}
              max={CELL_WIDTH.max}
              placeholder="auto"
              value={override.width ?? ""}
              onChange={(e) =>
                update(scope, (o) => ({
                  ...o,
                  width: e.target.value === "" ? undefined : Number(e.target.value),
                }))
              }
              aria-label={`Stroke width for ${scopeName}`}
            />
          </label>
          <AttrsEditor
            attrs={override.attrs}
            candidates={detailCandidates}
            fallback={doc.mapping.attrs}
            onChange={(attrs) => update(scope, (o) => ({ ...o, attrs }))}
          />
          <button
            type="button"
            className="btn btn-quiet ts-reset"
            disabled={emptyOverride(override)}
            onClick={() => update(scope, () => null)}
          >
            Give {scopeName} back to the global rules
          </button>
        </div>
      )}
      {types !== undefined && <OverflowNote total={values.length} />}
    </GroupShell>
  );
}
