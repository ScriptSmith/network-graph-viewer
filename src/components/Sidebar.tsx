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
import { edgeStyleColumns } from "../lib/doc";
import type { MetricOptions } from "../lib/metrics";
import type { MetricRun } from "../lib/metrics/runner";
import { exportAs, TEXT_EXTENSIONS, type ExportFormat, type ExportInput } from "../lib/io";
import { ComputePanel } from "./ComputePanel";
import { ScriptPanel, type ScriptRunRequest } from "./ScriptPanel";
import { GistLoad } from "./GistLoad";
import { SharePanel } from "./SharePanel";
import { FilterChain } from "./FilterChain";
import { PalettePicker } from "./PalettePicker";
import { SampleList } from "./SampleList";
import { EdgeStyleSection, NodeStyleSection } from "./StyleSection";
import { SAMPLES, type SampleNetwork } from "../samples";

interface SidebarProps {
  dataset: Dataset | null;
  edgeTableIndex: number;
  nodeTableIndex: number | null;
  doc: GraphDoc | null;
  style: GraphStyle;
  chain: FilterStep[];
  chainResults: ChainStepResult[];
  graph: Graph | null;
  /** Color maps in force, overrides included, for the type editors. */
  colors: Map<string, string>;
  edgeColors: Map<string, string>;
  selectedId: string | null;
  showIsolated: boolean;
  layout: LayoutId;
  layoutParams: LayoutParams;
  preventOverlap: boolean;
  labelMode: LabelMode;
  onFile: (file: File) => void;
  onSample: (network: SampleNetwork) => void;
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
  onExportHtml: () => void;
  onGist: (reference: string) => void;
  onGistSaved: (id: string) => void;
  gistId: string | null;
  buildLink: () => Promise<string | null>;
  /** Set only when embedded, where links must name the app and not the host page. */
  appUrl?: string;
  /** Inside a host, which drops the product title and the file-loading step. */
  embedded?: boolean;
  exportInput: () => ExportInput | null;
}

// The browse dialog offers everything `handleFile` can open, tabular and
// graph formats alike, so the picker is not narrower than a drop would be.
const ACCEPT = Array.from(new Set([...ACCEPTED_EXTENSIONS, ...TEXT_EXTENSIONS])).join(",");

/** In the order they appear. Embedded, "data" is dropped and the rest shuffle up. */
const STEPS = ["data", "columns", "filter", "style", "layout", "compute", "export"] as const;

export function Sidebar({
  dataset,
  edgeTableIndex,
  nodeTableIndex,
  doc,
  style,
  chain,
  chainResults,
  graph,
  colors,
  edgeColors,
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
  onExportHtml,
  onGist,
  onGistSaved,
  gistId,
  buildLink,
  appUrl,
  embedded = false,
  exportInput,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // These two lists survive here for the Layout step's column parameters; the
  // Style step's own lists live with the style sections now.
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

  const activeFilterCount = chain.filter((s) => s.enabled).length;
  const multiTable = (dataset?.tables.length ?? 0) > 1;
  // Embedded, the data came from the kernel: there is no file to choose,
  // and a product title inside somebody's notebook is just noise.
  const steps = embedded ? STEPS.filter((k) => k !== "data") : STEPS;
  const stepNo = (key: (typeof STEPS)[number]) =>
    (steps as readonly (typeof STEPS)[number][]).indexOf(key) + 1;

  return (
    <aside className={embedded ? "sidebar sidebar-embedded" : "sidebar"}>
      {!embedded && (
        <header className="brand">
          <h1>
            Network
            <br />
            Graph Viewer
          </h1>
          <p className="tagline">Data in, network out.</p>
        </header>
      )}

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept={ACCEPT}
        onChange={(e) => handleFiles(e.target.files)}
        aria-label="Upload a spreadsheet"
      />

      {!embedded && (
        <section className="step">
          <h2 className="step-head">
            <span className="step-no">{stepNo("data")}</span> Data
          </h2>
          <div className="step-body">
            {dataset && doc ? (
              <>
                <div className="file-chip" title={dataset.fileName}>
                  <span className="file-name">{dataset.fileName}</span>
                  <span className="file-meta">
                    {doc.edges.rows.length} edge rows · {doc.nodes.rows.length} nodes
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
                {/* The ways in that are not a file, folded away once something
                    is open: they replace what is on screen, so they should be
                    a deliberate reach rather than furniture. */}
                <details className="load-other">
                  <summary>Load something else</summary>
                  <div className="load-other-body">
                    <div className="field">
                      <span className="field-label">Sample networks</span>
                      <SampleList onPick={onSample} all />
                    </div>
                    <div className="field">
                      <span className="field-label">From a GitHub gist</span>
                      <GistLoad onLoad={onGist} />
                    </div>
                  </div>
                </details>
              </>
            ) : (
              <>
                <button type="button" className="mini-drop" onClick={pickFile}>
                  <strong>Choose a file</strong>
                  <span>or drop a file or paste cells anywhere on the page</span>
                </button>
                <div className="field">
                  <span className="field-label">Or start from a sample</span>
                  <button type="button" className="btn" onClick={() => onSample(SAMPLES[0])}>
                    Load sample dataset
                  </button>
                  <SampleList onPick={onSample} />
                </div>
                <div className="field">
                  <span className="field-label">Or load a GitHub gist</span>
                  <GistLoad onLoad={onGist} />
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <section className={doc ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">{stepNo("columns")}</span> Columns
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
          <span className="step-no">{stepNo("filter")}</span> Filter
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
          <span className="step-no">{stepNo("style")}</span> Style
        </h2>
        <div className="step-body">
          {doc ? (
            <>
              <NodeStyleSection
                doc={doc}
                style={style}
                colors={colors}
                labelMode={labelMode}
                onStyleChange={onStyleChange}
                onMappingChange={onMappingChange}
                onLabelModeChange={onLabelModeChange}
              />
              <EdgeStyleSection
                doc={doc}
                style={style}
                edgeColors={edgeColors}
                onStyleChange={onStyleChange}
                onMappingChange={onMappingChange}
              />
              <div className="style-group">
                <h3 className="style-group-head">Colors</h3>
                <PalettePicker style={style} onStyleChange={onStyleChange} />
              </div>
            </>
          ) : (
            <p className="note">Load data first.</p>
          )}
        </div>
      </section>

      <section className={graph ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">{stepNo("layout")}</span> Layout
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
          <span className="step-no">{stepNo("compute")}</span> Compute
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
          <span className="step-no">{stepNo("export")}</span> Export
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
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={!doc}
              onClick={onExportHtml}
              title="One self-contained file: the whole interactive viewer with the data inside"
            >
              HTML page
            </button>
          </div>
          <span className="field-label export-share-label">Share</span>
          <SharePanel
            ready={doc !== null}
            buildLink={buildLink}
            buildFiles={() => {
              const input = exportInput();
              if (!input) return null;
              const workspace = exportAs("workspace", input);
              const gexf = exportAs("gexf", input);
              return gexf.content ? [workspace, gexf] : [workspace];
            }}
            description={doc ? `${doc.name} — Network Graph Viewer` : "Network Graph Viewer"}
            loadedGistId={gistId}
            onSaved={onGistSaved}
            appUrl={appUrl}
          />
        </div>
      </section>

      <footer className="sidebar-footer">
        {!embedded && <p>Files are parsed in your browser and never uploaded.</p>}
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
