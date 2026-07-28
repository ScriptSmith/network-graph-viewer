import { useState } from "react";
import {
  clearToken,
  isTokenRemembered,
  readToken,
  saveGist,
  writeToken,
  type Gist,
} from "../lib/io";
import type { ExportedFile } from "../lib/io";

interface GistPanelProps {
  /** The files to write, built fresh each time so they reflect the current state. */
  buildFiles: () => ExportedFile[] | null;
  description: string;
  onLoad: (reference: string) => void;
}

export function GistPanel({ buildFiles, description, onLoad }: GistPanelProps) {
  const [reference, setReference] = useState("");
  const [token, setToken] = useState(() => readToken() ?? "");
  const [remember, setRemember] = useState(isTokenRemembered);
  const [gistId, setGistId] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Gist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const save = async () => {
    const files = buildFiles();
    if (!files || token.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      writeToken(token.trim(), remember);
      const gist = await saveGist({
        id: gistId.trim() || undefined,
        description,
        files,
        isPublic,
        token: token.trim(),
      });
      setSaved(gist);
      setGistId(gist.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that gist.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gist">
      <div className="gist-load">
        <input
          className="control"
          type="text"
          value={reference}
          placeholder="gist URL or id"
          onChange={(e) => setReference(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && reference.trim()) onLoad(reference);
          }}
          aria-label="Gist URL or id"
        />
        <button
          type="button"
          className="btn"
          disabled={reference.trim() === ""}
          onClick={() => onLoad(reference)}
        >
          Load
        </button>
      </div>

      <details className="gist-save" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Save to a gist</summary>
        <p className="note">
          Writing needs a personal access token with the <code>gist</code> scope. It is sent to
          api.github.com and nothing else, and is kept only for this tab unless you tick remember.
        </p>
        <label className="field">
          <span className="field-label">Token</span>
          <input
            className="control"
            type="password"
            value={token}
            placeholder="ghp_…"
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="check-item">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
              if (!e.target.checked) clearToken();
            }}
          />
          <span className="check-name">Remember on this device</span>
        </label>
        <label className="field">
          <span className="field-label">Gist id (blank creates a new one)</span>
          <input
            className="control"
            type="text"
            value={gistId}
            placeholder="new gist"
            onChange={(e) => setGistId(e.target.value)}
          />
        </label>
        <label className="check-item">
          <input
            type="checkbox"
            checked={isPublic}
            disabled={gistId.trim() !== ""}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span className="check-name">Make it public</span>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || token.trim() === ""}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : gistId.trim() ? "Update gist" : "Create gist"}
        </button>
        {error && <p className="warn">{error}</p>}
        {saved && !error && (
          <p className="note">
            Saved.{" "}
            <a href={saved.htmlUrl} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>{" "}
            or share{" "}
            <a href={`?gist=${saved.id}`} target="_blank" rel="noreferrer">
              this link
            </a>
            .
          </p>
        )}
      </details>
    </div>
  );
}
