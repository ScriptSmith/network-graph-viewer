/**
 * Graphs that travel in a link.
 *
 * A workspace is JSON, so a link can carry the whole thing: deflate it,
 * base64url it, and hang it off the fragment. The fragment is the point.
 * Browsers never send it with the request, so a graph shared as a link stays
 * as private as a dropped file, which is what the rest of the app promises.
 * A `?gist=` link names a gist instead, for graphs past the size an address
 * bar will take.
 */

export const DATA_KEY = "data";
export const GIST_KEY = "gist";

/** Payload prefixes, so a link says how it was packed rather than being sniffed. */
const DEFLATED = "z";
const PLAIN = "u";

/**
 * Roomy enough for a decent graph, short enough to survive being pasted into a
 * chat client or a mail body. Past it the panel points at gists instead.
 */
export const LINK_LIMIT = 8000;

export type UrlSource = { kind: "data"; payload: string } | { kind: "gist"; reference: string };

function hashParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.replace(/^#/, ""));
}

/**
 * The graph a location asks for, if any. The fragment is read first because
 * that is where links written here put the data; the query still works, for
 * `?gist=` links already in the wild and for anything hand-written.
 */
export function readUrlSource(href: string = window.location.href): UrlSource | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const places = [hashParams(url), url.searchParams];
  for (const place of places) {
    const payload = place.get(DATA_KEY);
    if (payload) return { kind: "data", payload };
  }
  for (const place of places) {
    const reference = place.get(GIST_KEY);
    if (reference) return { kind: "gist", reference };
  }
  return null;
}

/** A link carrying the data itself, in the fragment so it never leaves the browser. */
export function dataLink(payload: string, href: string = window.location.href): string {
  const url = new URL(href);
  url.search = "";
  url.hash = `${DATA_KEY}=${payload}`;
  return url.toString();
}

/** A link naming a gist, which is short whatever the graph weighs. */
export function gistLink(id: string, href: string = window.location.href): string {
  const url = new URL(href);
  url.hash = "";
  url.search = `?${GIST_KEY}=${id}`;
  return url.toString();
}

/** The same address with any graph taken out of it, for when the data changes. */
export function withoutUrlSource(href: string = window.location.href): string {
  const url = new URL(href);
  const hash = hashParams(url);
  hash.delete(DATA_KEY);
  hash.delete(GIST_KEY);
  url.searchParams.delete(DATA_KEY);
  url.searchParams.delete(GIST_KEY);
  const rest = hash.toString();
  url.hash = rest === "" ? "" : rest;
  return url.toString();
}

/** The stream APIs want a buffer they own outright, not a view onto any old one. */
type Bytes = Uint8Array<ArrayBuffer>;

function toBase64Url(bytes: Bytes): string {
  let binary = "";
  // Chunked: one apply over a few hundred thousand arguments blows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Bytes {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(chunks: Uint8Array[]): Bytes {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Push bytes through a compression stream and collect what comes out. */
async function pump(bytes: Bytes, stream: TransformStream<BufferSource, Uint8Array>) {
  const writer = stream.writable.getWriter();
  // Not awaited: the write only settles once the reader below drains it.
  void writer.write(bytes).catch(() => {});
  void writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(chunks);
}

/**
 * Pack text for a link. Deflate is the platform's, so this costs nothing to
 * ship; where it is missing the text rides uncompressed and the link is
 * simply longer.
 */
export async function encodePayload(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") return PLAIN + toBase64Url(bytes);
  try {
    return DEFLATED + toBase64Url(await pump(bytes, new CompressionStream("deflate-raw")));
  } catch {
    return PLAIN + toBase64Url(bytes);
  }
}

export async function decodePayload(payload: string): Promise<string> {
  const flag = payload.slice(0, 1);
  if (flag !== DEFLATED && flag !== PLAIN) {
    throw new Error("That link does not carry a graph this app wrote.");
  }
  let bytes: Bytes;
  try {
    bytes = fromBase64Url(payload.slice(1));
    if (flag === DEFLATED) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser cannot unpack compressed links.");
      }
      bytes = await pump(bytes, new DecompressionStream("deflate-raw"));
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("This browser")) throw e;
    throw new Error("That link is damaged or was cut short somewhere along the way.");
  }
  return new TextDecoder().decode(bytes);
}
