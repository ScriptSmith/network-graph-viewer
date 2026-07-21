import { useMemo, useRef } from "react";
import type { Dataset, Graph, LabelMode, LayoutId, Mapping, Sheet } from "../types";
import { LAYOUTS } from "../types";
import { ACCEPTED_EXTENSIONS, isNumericColumn } from "../lib/parse";

interface SidebarProps {
  dataset: Dataset | null;
  sheetIndex: number;
  sheet: Sheet | null;
  mapping: Mapping | null;
  graph: Graph | null;
  layout: LayoutId;
  labelMode: LabelMode;
  onFile: (file: File) => void;
  onSample: () => void;
  onClear: () => void;
  onSheetChange: (index: number) => void;
  onMappingChange: (patch: Partial<Mapping>) => void;
  onLayoutChange: (layout: LayoutId) => void;
  onLabelModeChange: (mode: LabelMode) => void;
  onExport: (format: "svg" | "png") => void;
}

const ACCEPT = ACCEPTED_EXTENSIONS.join(",");

export function Sidebar({
  dataset,
  sheetIndex,
  sheet,
  mapping,
  graph,
  layout,
  labelMode,
  onFile,
  onSample,
  onClear,
  onSheetChange,
  onMappingChange,
  onLayoutChange,
  onLabelModeChange,
  onExport,
}: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const numericColumns = useMemo(
    () => (sheet ? sheet.columns.filter((c) => isNumericColumn(sheet.rows, c)) : []),
    [sheet],
  );

  const pickFile = () => fileInputRef.current?.click();

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const attrCandidates = sheet
    ? sheet.columns.filter((c) => c !== mapping?.source && c !== mapping?.target)
    : [];

  const toggleAttr = (column: string) => {
    if (!mapping) return;
    const attrs = mapping.attrs.includes(column)
      ? mapping.attrs.filter((a) => a !== column)
      : [...mapping.attrs, column];
    onMappingChange({ attrs });
  };

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
          {dataset ? (
            <>
              <div className="file-chip" title={dataset.fileName}>
                <span className="file-name">{dataset.fileName}</span>
                <span className="file-meta">
                  {sheet ? `${sheet.rows.length} rows · ${sheet.columns.length} columns` : ""}
                </span>
              </div>
              {dataset.sheets.length > 1 && (
                <label className="field">
                  <span className="field-label">Sheet</span>
                  <select
                    className="control"
                    value={sheetIndex}
                    onChange={(e) => onSheetChange(Number(e.target.value))}
                  >
                    {dataset.sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
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
                <span>or drop it anywhere on the page</span>
              </button>
              <button type="button" className="btn" onClick={onSample}>
                Load sample dataset
              </button>
            </>
          )}
        </div>
      </section>

      <section className={sheet ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">2</span> Columns
        </h2>
        <div className="step-body">
          {sheet && mapping ? (
            <>
              <label className="field">
                <span className="field-label">Edge source</span>
                <select
                  className="control"
                  value={mapping.source}
                  onChange={(e) => onMappingChange({ source: e.target.value })}
                >
                  {sheet.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-quiet swap"
                onClick={() => onMappingChange({ source: mapping.target, target: mapping.source })}
                title="Swap source and target"
              >
                ⇅ swap
              </button>
              <label className="field">
                <span className="field-label">Edge target</span>
                <select
                  className="control"
                  value={mapping.target}
                  onChange={(e) => onMappingChange({ target: e.target.value })}
                >
                  {sheet.columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              {mapping.source === mapping.target && (
                <p className="warn">
                  Source and target are the same column, so every edge is a self-loop and gets
                  skipped.
                </p>
              )}
              <label className="field">
                <span className="field-label">Color nodes by</span>
                <select
                  className="control"
                  value={mapping.color ?? ""}
                  onChange={(e) => onMappingChange({ color: e.target.value || null })}
                >
                  <option value="">None (single color)</option>
                  {sheet.columns
                    .filter((c) => c !== mapping.source && c !== mapping.target)
                    .map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Edge width from</span>
                <select
                  className="control"
                  value={mapping.weight ?? ""}
                  onChange={(e) => onMappingChange({ weight: e.target.value || null })}
                >
                  <option value="">Uniform width</option>
                  {numericColumns
                    .filter((c) => c !== mapping.source && c !== mapping.target)
                    .map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                </select>
              </label>
              {attrCandidates.length > 0 && (
                <fieldset className="check-list">
                  <legend className="field-label">Edge details on hover</legend>
                  {attrCandidates.map((c) => (
                    <label key={c} className="check-item">
                      <input
                        type="checkbox"
                        checked={mapping.attrs.includes(c)}
                        onChange={() => toggleAttr(c)}
                      />
                      <span>{c}</span>
                    </label>
                  ))}
                </fieldset>
              )}
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

      <section className={graph ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">3</span> Layout
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
          <label className="field">
            <span className="field-label">Labels</span>
            <select
              className="control"
              value={labelMode}
              disabled={!graph}
              onChange={(e) => onLabelModeChange(e.target.value as LabelMode)}
            >
              <option value="auto">Auto (declutter large graphs)</option>
              <option value="all">All nodes</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>
      </section>

      <section className={graph ? "step" : "step step-disabled"}>
        <h2 className="step-head">
          <span className="step-no">4</span> Export
        </h2>
        <div className="step-body btn-row">
          <button type="button" className="btn" disabled={!graph} onClick={() => onExport("svg")}>
            Download SVG
          </button>
          <button type="button" className="btn" disabled={!graph} onClick={() => onExport("png")}>
            Download PNG
          </button>
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
