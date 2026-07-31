/**
 * How a compute worker comes into existence.
 *
 * Served as a page the worker is its own chunk, fetched the first time someone
 * runs a metric and never by anyone who does not. A widget has no second file
 * to fetch, so the embed build aliases `#worker` to `spawn.inline.ts`, which
 * carries the worker inside the bundle instead. Everything else imports the
 * alias and never learns which of the two it got.
 */
export function spawnComputeWorker(): Worker {
  return new Worker(new URL("./compute.worker.ts", import.meta.url), { type: "module" });
}
