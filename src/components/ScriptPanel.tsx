import { useEffect, useState } from "react";
import type { ScriptMode } from "../lib/script/payload";

const STORAGE_KEY = "ngv.scripts";

export interface ScriptRunRequest {
  code: string;
  mode: ScriptMode;
  column: string;
}

interface ScriptPanelProps {
  onRun: (request: ScriptRunRequest) => Promise<string>;
}

const EXAMPLES: Record<ScriptMode, { column: string; code: string }> = {
  node: {
    column: "Root degree",
    code: `// graph = { nodes, edges, neighbors, directed }
// Return { nodeId: number } — it becomes a column.
const out = {};
for (const node of graph.nodes) {
  out[node.id] = Math.sqrt(graph.neighbors[node.id].length);
}
return out;`,
  },
  edge: {
    column: "Endpoint gap",
    code: `// Return { "source->target": number } — it becomes an edge column.
const degree = {};
for (const node of graph.nodes) degree[node.id] = graph.neighbors[node.id].length;

const out = {};
for (const edge of graph.edges) {
  out[edge.source + "->" + edge.target] = Math.abs(degree[edge.source] - degree[edge.target]);
}
return out;`,
  },
  layout: {
    column: "",
    code: `// Return { nodeId: { x, y } } — it becomes the layout.
// This one is a spiral ordered by degree.
const sorted = [...graph.nodes].sort((a, b) => b.degree - a.degree);
const out = {};
sorted.forEach((node, i) => {
  const angle = i * 2.39996;
  const radius = 30 * Math.sqrt(i + 1);
  out[node.id] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
});
return out;`,
  },
};

function loadSaved(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function ScriptPanel({ onRun }: ScriptPanelProps) {
  const [mode, setMode] = useState<ScriptMode>("node");
  const [code, setCode] = useState(EXAMPLES.node.code);
  const [column, setColumn] = useState(EXAMPLES.node.column);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>(loadSaved);
  const [saveName, setSaveName] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Storage may be unavailable; scripts still run, they just do not persist.
    }
  }, [saved]);

  const switchMode = (next: ScriptMode) => {
    setMode(next);
    setCode(EXAMPLES[next].code);
    setColumn(EXAMPLES[next].column);
    setMessage(null);
    setError(null);
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await onRun({ code, mode, column }));
    } catch (e) {
      const detail = e instanceof Error && typeof e.cause === "string" ? `\n${e.cause}` : "";
      setError((e instanceof Error ? e.message : "The script failed.") + detail);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="script">
      <div className="script-modes" role="radiogroup" aria-label="What the script produces">
        {(["node", "edge", "layout"] as ScriptMode[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? "script-mode active" : "script-mode"}
            onClick={() => switchMode(id)}
          >
            {id === "node" ? "Node metric" : id === "edge" ? "Edge metric" : "Layout"}
          </button>
        ))}
      </div>

      <textarea
        className="script-code"
        spellCheck={false}
        value={code}
        rows={12}
        onChange={(e) => setCode(e.target.value)}
        aria-label="Script"
      />

      {mode !== "layout" && (
        <label className="field">
          <span className="field-label">Column name</span>
          <input
            className="control"
            type="text"
            value={column}
            onChange={(e) => setColumn(e.target.value)}
            placeholder="My metric"
          />
        </label>
      )}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={running || (mode !== "layout" && column.trim() === "")}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Run script"}
        </button>
      </div>

      <p className="note script-limits">3s deadline · 64 MB · no network · seeded randomness</p>

      {error && <p className="warn script-error">{error}</p>}
      {message && !error && <p className="note">{message}</p>}

      <details className="script-saved">
        <summary>Saved scripts ({Object.keys(saved).length})</summary>
        <div className="script-save-row">
          <input
            className="control"
            type="text"
            value={saveName}
            placeholder="name"
            onChange={(e) => setSaveName(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={saveName.trim() === ""}
            onClick={() => {
              setSaved((s) => ({ ...s, [saveName.trim()]: code }));
              setSaveName("");
            }}
          >
            Save
          </button>
        </div>
        {Object.entries(saved).map(([name, body]) => (
          <div key={name} className="script-saved-row">
            <button type="button" className="script-load" onClick={() => setCode(body)}>
              {name}
            </button>
            <button
              type="button"
              className="script-forget"
              aria-label={`Forget ${name}`}
              onClick={() =>
                setSaved((s) => {
                  const next = { ...s };
                  delete next[name];
                  return next;
                })
              }
            >
              ×
            </button>
          </div>
        ))}
      </details>
    </div>
  );
}
