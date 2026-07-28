/**
 * GitHub gists as a place to keep graphs.
 *
 * Reading needs nothing: the gists API is CORS-enabled and allows 60
 * unauthenticated requests an hour per IP. Writing needs a token, and a
 * Personal Access Token is the only route that avoids registering a GitHub
 * App, because the OAuth device flow wants a client id and a client id means
 * an app. The token is sent to api.github.com and nowhere else.
 */

const API = "https://api.github.com";
const TOKEN_KEY = "ngv.gist.token";

export interface GistFile {
  name: string;
  content: string;
}

export interface Gist {
  id: string;
  description: string;
  files: GistFile[];
  htmlUrl: string;
}

/**
 * Pull a gist id out of whatever the user pasted: the gist page, a raw file
 * URL, an API URL, or the bare id.
 */
export function extractGistId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (/^[0-9a-f]{20,32}$/i.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const isGistHost =
    host === "gist.github.com" ||
    host === "gist.githubusercontent.com" ||
    host === "api.github.com" ||
    host === "github.com";
  if (!isGistHost) return null;

  // api.github.com/gists/<id> and github.com/<user>/<id> both end up here.
  const afterGists = segments.indexOf("gists");
  const candidates = afterGists === -1 ? segments : segments.slice(afterGists + 1);
  return candidates.find((segment) => /^[0-9a-f]{20,32}$/i.test(segment)) ?? null;
}

/** `#file-my-data-csv` in a gist URL points at one file; recover its name. */
export function extractGistFileHint(input: string): string | null {
  const hash = input.includes("#") ? input.slice(input.indexOf("#") + 1) : "";
  if (!hash.startsWith("file-")) return null;
  return hash.slice(5);
}

/** Does a hinted fragment name this file? GitHub slugifies dots to dashes. */
export function matchesFileHint(fileName: string, hint: string): boolean {
  return fileName.toLowerCase().replace(/[^a-z0-9]+/g, "-") === hint.toLowerCase();
}

function authHeaders(token: string | null): HeadersInit {
  const headers: HeadersInit = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function failure(response: Response, action: string): Promise<Error> {
  if (response.status === 404) {
    return new Error(`No gist found (404). Private gists need a token with the gist scope.`);
  }
  if (response.status === 401) return new Error("GitHub rejected that token (401).");
  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      return new Error(
        "GitHub's rate limit for anonymous requests is used up (60/hour). Adding a token raises it.",
      );
    }
    return new Error("GitHub refused the request (403).");
  }
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    detail = body.message ? `: ${body.message}` : "";
  } catch {
    detail = "";
  }
  return new Error(`Could not ${action} (${response.status})${detail}.`);
}

interface RawGist {
  id: string;
  description: string | null;
  html_url: string;
  files: Record<
    string,
    { filename: string; content: string; truncated?: boolean; raw_url: string } | null
  >;
}

export async function fetchGist(id: string, token = readToken()): Promise<Gist> {
  const response = await fetch(`${API}/gists/${id}`, { headers: authHeaders(token) });
  if (!response.ok) throw await failure(response, "load that gist");
  const raw = (await response.json()) as RawGist;

  const files: GistFile[] = [];
  for (const entry of Object.values(raw.files)) {
    if (!entry) continue;
    // Large files come back truncated, with the whole thing at raw_url.
    const content = entry.truncated
      ? await fetch(entry.raw_url).then((r) => r.text())
      : entry.content;
    files.push({ name: entry.filename, content });
  }
  if (files.length === 0) throw new Error("That gist has no files.");
  return { id: raw.id, description: raw.description ?? "", files, htmlUrl: raw.html_url };
}

export interface SaveGistOptions {
  /** Omit to create a new gist, supply to update an existing one. */
  id?: string;
  description: string;
  files: GistFile[];
  isPublic?: boolean;
  token: string;
}

export async function saveGist(options: SaveGistOptions): Promise<Gist> {
  const body: Record<string, unknown> = {
    description: options.description,
    files: Object.fromEntries(options.files.map((f) => [f.name, { content: f.content }])),
  };
  if (!options.id) body.public = options.isPublic ?? false;

  const response = await fetch(options.id ? `${API}/gists/${options.id}` : `${API}/gists`, {
    method: options.id ? "PATCH" : "POST",
    headers: { ...authHeaders(options.token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw await failure(response, options.id ? "update that gist" : "create a gist");
  const raw = (await response.json()) as RawGist;
  return {
    id: raw.id,
    description: raw.description ?? "",
    files: Object.values(raw.files)
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .map((f) => ({ name: f.filename, content: f.content })),
    htmlUrl: raw.html_url,
  };
}

/**
 * The token lives in sessionStorage by default, so closing the tab forgets it.
 * "Remember on this device" promotes it to localStorage, which is a real
 * trade: convenience against a token sitting in browser storage.
 */
export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string, remember: boolean): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (remember) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked entirely; the token still works for this run.
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clean up if storage was unavailable.
  }
}

export function isTokenRemembered(): boolean {
  try {
    return localStorage.getItem(TOKEN_KEY) !== null;
  } catch {
    return false;
  }
}
