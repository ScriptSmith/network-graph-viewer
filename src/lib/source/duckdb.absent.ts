import type { DataSource } from "./types";

/**
 * The query engine, left out.
 *
 * The widget and the standalone export are single files: anywidget loads one
 * module out of a Python package, and an exported page is one HTML document.
 * Neither can fetch a sibling chunk, so a library build folds every dynamic
 * import into the bundle and inlines the assets those imports name. That turns
 * eight megabytes of wasm into a base64 string in a file that was three and a
 * half megabytes whole, for a path neither build can reach: both are handed
 * their data rather than opening files from a disk.
 *
 * So the engine is aliased to this instead. Nothing here is reachable, because
 * nothing in those two entries opens a file large enough to ask for it, and
 * saying so plainly beats a bundle that silently grew fourteen times.
 */
export function duckdbSource(
  _input?: File | { url: string },
  _options?: { edgeLimit?: number },
): DataSource {
  throw new Error("Large sources need the full app; this build cannot open one.");
}
