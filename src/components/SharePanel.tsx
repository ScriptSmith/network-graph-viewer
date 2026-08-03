import { useEffect, useRef, useState } from "react";
import {
  clearToken,
  gistLink,
  isTokenRemembered,
  LINK_LIMIT,
  readToken,
  saveGist,
  writeToken,
  type ExportedFile,
} from "../lib/io";

/** How long the button holds its answer. Long enough to be seen, short
 *  enough that it is gone before the next click. */
const COPIED_MS = 1800;

interface SharePanelProps {
  /** False with no data loaded: nothing to share, but a typed token is kept. */
  ready: boolean;
  /** Built fresh on each click, so a link always holds the current session. */
  buildLink: () => Promise<string | null>;
  buildFiles: () => ExportedFile[] | null;
  description: string;
  /** The gist this graph came from, if any, so saving offers to update it. */
  loadedGistId: string | null;
  onSaved: (id: string) => void;
  /**
   * Where the app is served from. Only set when embedded, where the page's own
   * address is somebody else's and a link built from it would go nowhere.
   */
  appUrl?: string;
}

/**
 * The two ways a graph leaves the browser without becoming a file: packed into
 * a link, or pushed to a gist and named by a much shorter one.
 */
export function SharePanel({
  ready,
  buildLink,
  buildFiles,
  description,
  loadedGistId,
  onSaved,
  appUrl,
}: SharePanelProps) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [building, setBuilding] = useState(false);
  const [token, setToken] = useState(() => readToken() ?? "");
  const [remember, setRemember] = useState(isTokenRemembered);
  const [gistId, setGistId] = useState(loadedGistId ?? "");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Opening a gist link fills the field in, so the obvious next save updates
  // the gist it came from rather than quietly making a second one.
  const [lastLoaded, setLastLoaded] = useState(loadedGistId);
  if (loadedGistId !== lastLoaded) {
    setLastLoaded(loadedGistId);
    setGistId(loadedGistId ?? "");
  }

  // The clipboard takes the link silently, so the button is the only place the
  // click can show for anything: it fills in and says so for a moment. The
  // state is dropped first, so a second copy replays the flash rather than
  // sitting through the tail of the first one.
  const held = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(held.current), []);

  const share = async () => {
    setCopied(false);
    setBlocked(false);
    setError(null);
    setBuilding(true);
    window.clearTimeout(held.current);
    try {
      const url = await buildLink();
      if (!url) return;
      setLink(url);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        held.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      } catch {
        // Clipboards are refused outside a secure context and behind some
        // permission prompts; the field below still holds the link.
        setBlocked(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build a link.");
    } finally {
      setBuilding(false);
    }
  };

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
      setSavedId(gist.id);
      setSavedUrl(gist.htmlUrl);
      setGistId(gist.id);
      onSaved(gist.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that gist.");
    } finally {
      setSaving(false);
    }
  };

  const tooLong = link !== null && link.length > LINK_LIMIT;

  return (
    <div className="share">
      <button
        type="button"
        className={copied ? "btn share-copy is-copied" : "btn share-copy"}
        disabled={building || !ready}
        onClick={() => void share()}
        title="A link with the whole graph packed into it"
      >
        {copied && (
          <svg className="share-tick" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 8.5 6.5 12 13 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {building ? "Building…" : copied ? "Copied" : "Copy link"}
      </button>
      {/* The button's own label changes too fast to be read out reliably. */}
      <span className="visually-hidden" role="status">
        {copied ? "Link copied to the clipboard." : ""}
      </span>
      {link && (
        <>
          <input
            className="control share-url"
            type="text"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Link to this graph"
          />
          {blocked && (
            <p className="warn">
              This browser would not let the page reach the clipboard. The link is in the field
              above; copy it from there.
            </p>
          )}
          {tooLong ? (
            <p className="warn">
              {link.length.toLocaleString()} characters. Some mail and chat clients cut links
              shorter than that; for a graph this size a gist travels better.
            </p>
          ) : (
            <p className="note">
              The whole graph rides in the # part of the link, which browsers never send to a
              server.
            </p>
          )}
        </>
      )}

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
          disabled={saving || !ready || token.trim() === ""}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : gistId.trim() ? "Update gist" : "Create gist"}
        </button>
        {savedId && savedUrl && !error && (
          <p className="note">
            {appUrl ? "Saved." : "Saved, and the address bar now points at it."}{" "}
            <a href={savedUrl} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>{" "}
            or share{" "}
            <a href={gistLink(savedId, appUrl)} target="_blank" rel="noreferrer">
              this link
            </a>
            .
          </p>
        )}
      </details>
      {error && <p className="warn">{error}</p>}
    </div>
  );
}
