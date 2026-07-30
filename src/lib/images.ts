/**
 * Node images. A cell can hold whatever the source system had to hand: a data
 * URI, raw SVG markup, a bare base64 blob with the header lost somewhere in a
 * spreadsheet, or a link to a file on the web. Each becomes something an
 * `<image>` element can render, and anything else becomes null rather than a
 * broken mark.
 *
 * Only http, https and image data URIs are let through: a cell is untrusted
 * text, and an `<image>` pointed at anything else is either a dead reference
 * or a way to smuggle a scheme past the rest of the app. SVG inside an image
 * reference renders in the browser's restricted mode, with no scripting and no
 * external fetches of its own, so markup from a file is safe to draw.
 */
import type { CellValue } from "../types";

/**
 * Base64 magic prefixes, enough to name the type the header didn't. Base64
 * packs three bytes into four characters, so each prefix stops at the last
 * character the signature alone decides: past that it depends on what the
 * particular file happens to say next.
 */
const BASE64_TYPES: [string, string][] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGO", "image/gif"],
  ["UklGR", "image/webp"],
  ["PHN2Z", "image/svg+xml"], // <svg
  ["PD94b", "image/svg+xml"], // <?xml
];

const BASE64_ONLY = /^[A-Za-z0-9+/=]+$/;

/** Markup, rather than a reference to it: an XML prolog or a comment may lead. */
function isSvgMarkup(text: string): boolean {
  return text.startsWith("<") && /<svg[\s>]/i.test(text) && /<\/svg\s*>/i.test(text);
}

/**
 * A cell as an image source, or null when it holds nothing usable. Data URIs
 * and http(s) URLs pass through; SVG markup and bare base64 are wrapped into
 * data URIs so the canvas and an exported SVG can both draw them.
 */
export function imageSource(value: CellValue): string | null {
  if (value === null || typeof value === "boolean" || typeof value === "number") return null;
  const text = value.trim();
  if (text === "") return null;

  if (/^data:/i.test(text)) {
    return /^data:image\/[a-z0-9.+-]+[;,]/i.test(text) ? text : null;
  }
  if (/^https?:\/\//i.test(text)) return text;
  if (isSvgMarkup(text)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  }

  // A base64 blob that lost its header: the first bytes still say what it is.
  const packed = text.replace(/\s+/g, "");
  if (packed.length > 24 && BASE64_ONLY.test(packed)) {
    const type = BASE64_TYPES.find(([prefix]) => packed.startsWith(prefix));
    if (type) return `data:${type[1]};base64,${packed}`;
  }
  return null;
}
