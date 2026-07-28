import { useMemo, useRef } from "react";
import type { Dataset, Graph, GraphDoc, GraphStyle, LabelMode, Mapping } from "../types";
import {
  layoutDefinition,
  LAYOUTS,
  type LayoutId,
  type LayoutParams,
  type ParamValue,
} from "../lib/layouts";
import type { ChainStepResult, FilterStep } from "../lib/filter";
import type { EditTarget } from "../lib/edit";
import { ACCEPTED_EXTENSIONS } from "../lib/parse";
import { edgeStyleColumns, nodeStyleColumns } from "../lib/doc";
import type { MetricOptions } from "../lib/metrics";
import type { MetricRun } from "../lib/metrics/runner";
import { exportAs, type ExportFormat, type ExportInput } from "../lib/io";
import { ComputePanel } from "./ComputePanel";
import { ScriptPanel, type ScriptRunRequest } from "./ScriptPanel";
import { GistPanel } from "./GistPanel";
import { FilterChain } from "./FilterChain";

interface SidebarProps {
  dataset: Dataset | null;
  edgeTableIndex: number;
  nodeTableIndex: number | null;
  doc: GraphDoc | null;
  style: GraphStyle;
  chain: FilterStep[];
  chainResults: ChainStepResult[];
  graph: Graph | null;
  selectedId: string | null;
  showIsolated: boolean;
  layout: LayoutId;
  layoutParams: LayoutParams;
  preventOverlap: boolean;
  labelMode: LabelMode;
  onFile: (file: File) => void;
  onSample: () => void;
  onClear: () => void;
  onTableChange: (edgeIndex: number, nodeIndex: number | null) => void;
  onMappingChange: (patch: Partial<Mapping>) => void;
  onStyleChange: (patch: Partial<GraphStyle>) => void;
  onChainChange: (chain: FilterStep[]) => void;
  onShowIsolatedChange: (show: boolean) => void;
  onCompute: (metrics: string[], options: MetricOptions) => Promise<MetricRun>;
  onClearComputed: () => void;
  onShowColumns: (target: EditTarget) => void;
  onScript: (request: ScriptRunRequest) => Promise<string>;
  onLayoutChange: (layout: LayoutId) => void;
  onLayoutParamChange: (key: string, value: ParamValue) => void;
  onPreventOverlapChange: (value: boolean) => void;
  onSeparate: () => void;
  onLabelModeChange: (mode: LabelMode) => void;
  onExport: (format: "svg" | "png") => void;
  onExportData: (format: ExportFormat) => void;
  onGist: (reference: string) => void;
  exportInput: () => ExportInput | null;
}

const ACCEPT = ACCEPTED_EXTENSIONS.join(",");

export function Sidebar({
  dataset,
  edgeTableIndex,
  nodeTableIndex,
  doc,
  style,
  chain,
  chainResults,
  graph,
  selectedId,
  showIsolated,
  layout,
  layoutParams,
  preventOverlap,
  labelMode,
  onFile,
  onSample,
  onClear,
  onTableChange,
  onMappingChange,
  onStyleChange,
  onChainChange,
  onShowIsolatedChange,
  onCompute,
  onClearComputed,
  onShowColumns,
  onScript,
  onLayoutChange,
  onLayoutParamChange,
  onPreventOverlapChange,
  onSeparate,
  onLabelModeChange,
  onExport,
  onExportData,
  onGist,
  exportInput,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const nodeColumns = useMemo(() => (doc ? nodeStyleColumns(doc) : []), [doc]);
  const edgeColumns = useMemo(() => (doc ? edgeStyleColumns(doc) : []), [doc]);
  const nodeTableColumns = useMemo(
    () => (doc ? doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn) : []),
    [doc],
  );

  const pickFile = () => fileInputRef.current?.click();

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const toggleAttr = (column: string) => {
    if (!doc) return;
    const attrs = doc.mapping.attrs.includes(column)
      ? doc.mapping.attrs.filter((a) => a !== column)
      : [...doc.mapping.attrs, column];
    onMappingChange({ attrs });
  };

  const activeFilterCount = chain.filter((s) => s.enabled).length;
  const multiTable = (dataset?.tables.length ?? 0) > 1;

  return (
    <aside className="sidebar">
      <header className="brand">
        <h1>
          Network
          <br />
          Graph Viewer
        </h1>
        <p className="tagline">Spreadsheet in, network out.</p>
      </header>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept={ACCEPT}
        onChange={(e) => handleFiles(e.target.files)}
        aria-label="Upload a spreadsheet"
      />

      <section className="step">
        <h2 className="step-head">
          <span className="step-no">1</span> Data
        </h2>
        <div className="step-body">
          {dataset && doc ? (
            <>
              <div className="file-chip" title={dataset.fileName}>
                <span className="file-name">{dataset.fileName}</span>
                <span className="file-meta">
                  {doc.edges.rows.length} rows · {doc.edges.columns.length} columns
                </span>
              </div>
              {multiTable && (
                <>
                  <label className="field">
                    <span className="field-label">Edge sheet</span>
                    <select
                      className="control"
                      value={edgeTableIndex}
                      onChange={(e) => onTableChange(Number(e.target.value), nodeTableIndex)}
                    >
                      {dataset.tables.map((t, i) => (
                        <option key={t.name} value={i}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">Node attributes sheet</span>
                    <select
                      className="control"
                      value={nodeTableIndex ?? ""}
                      onChange={(e) =>
                        onTableChange(
                          edgeTableIndex,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    >
                      <option value="">None (derive from edges)</option>
                      {dataset.tables.map((t, i) =>
                        i === edgeTableIndex ? null : (
                          <option key={t.name} value={i}>
                            {t.name}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                </>
              )}
              <div className="btn-row">
                <button type="button" className="btn" onClick={pickFile}>
                  Replace file
                </button>
                <button type="button" className="btn btn-quiet" onClick={onClear}>
                  Clear
                </button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="mini-drop" onClick={pickFile}>
                <strong>Choose a file</strong>
                <span>or drop a file or paste cells anywhere on the page</span>
              </button>
              <button type="button" className="btn" onClick={onSample}>
                Load sample dataset
              </button>
            </>
          )}
          <GistPanel
            description={doc ? `${doc.name} — Network Graph Viewer` : "Network Graph Viewer"}
            buildFiles={() => {
              const input = exportInput();
              if (!input) return null;
              const workspace = exportAs("workspace", input);
              const gexf = exportAs("gexf", input);
              return gexf.content ? [workspace, gexf] : [workspace];
            }}
            onLoad={onGist}
          />
        </div>
      </section>

      <section className={doc ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">2</span> Columns
        </h2>
        <div className="step-body">
          {doc ? (
            <>
              <label className="field">
                <span className="field-label">Edge source</span>
                <select
                  className="control"
                  value={doc.mapping.source}
                  onChange={(e) => onMappingChange({ source: e.target.value })}
                >
                  {doc.edges.columns.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-quiet swap"
                onClick={() =>
                  onMappingChange({ source: doc.mapping.target, target: doc.mapping.source })
                }
                title="Swap source and target"
              >
                ⇅ swap
              </button>
              <label className="field">
                <span className="field-label">Edge target</span>
                <select
                  className="control"
                  value={doc.mapping.target}
                  onChange={(e) => onMappingChange({ target: e.target.value })}
                >
                  {doc.edges.columns.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </label>
              {doc.mapping.source === doc.mapping.target && (
                <p className="warn">
                  Source and target are the same column, so every edge is a self-loop and gets
                  skipped.
                </p>
              )}
              {edgeColumns.length > 0 && (
                <fieldset className="check-list">
                  <legend className="field-label">Edge details on hover</legend>
                  {edgeColumns.map((c) => (
                    <label key={c.name} className="check-item">
                      <input
                        type="checkbox"
                        checked={doc.mapping.attrs.includes(c.name)}
                        onChange={() => toggleAttr(c.name)}
                      />
                      <span className="check-name">{c.name}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="note">
                {doc.nodes.rows.length} nodes{" "}
                {doc.nodesDeclared ? "from the node sheet" : "derived from the edge endpoints"}.
              </p>
              <label className="check-item">
                <input
                  type="checkbox"
                  checked={showIsolated}
                  onChange={(e) => onShowIsolatedChange(e.target.checked)}
                />
                <span className="check-name">Show nodes with no edges</span>
              </label>
              {graph && graph.skippedRows > 0 && (
                <p className="note">
                  {graph.skippedRows} {graph.skippedRows === 1 ? "row" : "rows"} skipped (empty
                  endpoint or self-loop).
                </p>
              )}
            </>
          ) : (
            <p className="note">Load data first.</p>
          )}
        </div>
      </section>

      <section className={doc ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">3</span> Filter
          {activeFilterCount > 0 && <span className="step-badge">{activeFilterCount}</span>}
        </h2>
        <div className="step-body">
          {doc ? (
            <FilterChain
              doc={doc}
              chain={chain}
              results={chainResults}
              selectedId={selectedId}
              onChange={onChainChange}
            />
          ) : (
            <p className="note">Load data first.</p>
          )}
        </div>
      </section>

      <section className={doc ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">4</span> Style
        </h2>
        <div className="step-body">
          {doc ? (
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
                    {nodeColumns.map((c) => (
                      <option key={c.name} value={`column:${c.name}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
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
                    {nodeColumns
                      .filter((c) => c.type === "number")
                      .map((c) => (
                        <option key={c.name} value={`column:${c.name}`}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Color edges by</span>
                <select
                  className="control"
                  value={style.edgeColor}
                  onChange={(e) => onStyleChange({ edgeColor: e.target.value })}
                >
                  <option value="uniform">Uniform</option>
                  {edgeColumns
                    .filter((c) => c.type !== "number")
                    .map((c) => (
                      <option key={c.name} value={`column:${c.name}`}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Edge width from</span>
                <select
                  className="control"
                  value={style.edgeWidth}
                  onChange={(e) => onStyleChange({ edgeWidth: e.target.value })}
                >
                  <option value="uniform">Uniform width</option>
                  {edgeColumns
                    .filter((c) => c.type === "number")
                    .map((c) => (
                      <option key={c.name} value={`column:${c.name}`}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="check-item">
                <input
                  type="checkbox"
                  checked={style.arrows}
                  onChange={(e) => onStyleChange({ arrows: e.target.checked })}
                />
                <span className="check-name">Direction arrows</span>
              </label>
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
            </>
          ) : (
            <p className="note">Load data first.</p>
          )}
        </div>
      </section>

      <section className={graph ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">5</span> Layout
        </h2>
        <div className="step-body">
          <div className="radio-list" role="radiogroup" aria-label="Layout algorithm">
            {LAYOUTS.map((l) => (
              <label key={l.id} className="radio-item">
                <input
                  type="radio"
                  name="layout"
                  value={l.id}
                  checked={layout === l.id}
                  disabled={!graph}
                  onChange={() => onLayoutChange(l.id)}
                />
                <span className="radio-name">{l.name}</span>
                <span className="radio-blurb">{l.blurb}</span>
              </label>
            ))}
          </div>

          {graph &&
            layoutDefinition(layout).params.map((param) => {
              if (param.kind === "number") {
                const value = Number(layoutParams[param.key] ?? param.default);
                return (
                  <label key={param.key} className="field">
                    <span className="field-label">
                      {param.name} {param.step < 1 ? value.toFixed(1) : value}
                    </span>
                    <input
                      type="range"
                      className="range"
                      min={param.min}
                      max={param.max}
                      step={param.step}
                      value={value}
                      onChange={(e) => onLayoutParamChange(param.key, Number(e.target.value))}
                    />
                  </label>
                );
              }
              if (param.kind === "boolean") {
                return (
                  <label key={param.key} className="check-item" title={param.blurb}>
                    <input
                      type="checkbox"
                      checked={Boolean(layoutParams[param.key] ?? param.default)}
                      onChange={(e) => onLayoutParamChange(param.key, e.target.checked)}
                    />
                    <span className="check-name">{param.name}</span>
                  </label>
                );
              }
              // Node params read the node table directly, so only real node
              // columns can appear; the empty option falls back to the colour.
              const choices =
                param.scope === "nodes"
                  ? nodeTableColumns
                  : edgeColumns.filter((c) => c.type === "number");
              return (
                <label key={param.key} className="field">
                  <span className="field-label">{param.name}</span>
                  <select
                    className="control"
                    value={String(layoutParams[param.key] ?? param.default)}
                    onChange={(e) => onLayoutParamChange(param.key, e.target.value)}
                  >
                    <option value="">
                      {param.scope === "nodes" ? "Whatever colours the nodes" : "None"}
                    </option>
                    {choices.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                </label>
              );
            })}

          <label className="field">
            <span className="field-label">Spacing</span>
            <input
              type="range"
              className="range"
              min={0.6}
              max={1.8}
              step={0.1}
              value={style.spacing}
              disabled={!graph}
              onChange={(e) => onStyleChange({ spacing: Number(e.target.value) })}
            />
          </label>
          <label className="check-item">
            <input
              type="checkbox"
              checked={preventOverlap}
              disabled={!graph}
              onChange={(e) => onPreventOverlapChange(e.target.checked)}
            />
            <span className="check-name">Keep nodes from overlapping</span>
          </label>
          <button type="button" className="btn" disabled={!graph} onClick={onSeparate}>
            Fix overlaps now
          </button>
        </div>
      </section>

      <section className={doc ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">6</span> Compute
        </h2>
        <div className="step-body">
          {doc && graph ? (
            <ComputePanel
              doc={doc}
              nodeCount={graph.nodes.length}
              edgeCount={graph.links.length}
              onCompute={onCompute}
              onClearComputed={onClearComputed}
              onShowColumns={onShowColumns}
            />
          ) : (
            <p className="note">Load data first.</p>
          )}
          {doc && graph && (
            <details className="script-block">
              <summary>Write your own</summary>
              <ScriptPanel onRun={onScript} />
            </details>
          )}
        </div>
      </section>

      <section className={graph ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">7</span> Export
        </h2>
        <div className="step-body">
          <div className="btn-row">
            <button type="button" className="btn" disabled={!graph} onClick={() => onExport("svg")}>
              SVG
            </button>
            <button type="button" className="btn" disabled={!graph} onClick={() => onExport("png")}>
              PNG
            </button>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={!graph}
              onClick={() => onExportData("gexf")}
              title="Gephi's format, including positions and colours"
            >
              GEXF
            </button>
            <button
              type="button"
              className="btn"
              disabled={!doc}
              onClick={() => onExportData("graphml")}
            >
              GraphML
            </button>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={!doc}
              onClick={() => onExportData("workspace")}
              title="Everything: both tables, filters, styling, layout and positions"
            >
              Workspace
            </button>
            <button
              type="button"
              className="btn"
              disabled={!doc}
              onClick={() => onExportData("csv")}
            >
              CSV
            </button>
          </div>
        </div>
      </section>

      <footer className="sidebar-footer">
        <p>Files are parsed in your browser and never uploaded.</p>
        <a
          href="https://github.com/ScriptSmith/network-graph-viewer"
          target="_blank"
          rel="noreferrer"
        >
          Source on GitHub
        </a>
      </footer>
    </aside>
  );
}
