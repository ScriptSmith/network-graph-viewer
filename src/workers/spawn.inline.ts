/**
 * The embed build's `#worker`. See `spawn.ts` for why there are two: a widget
 * ships as one file, so the worker rides along inside it as a blob rather than
 * being fetched from a URL that would not resolve.
 */
import ComputeWorker from "./compute.worker?worker&inline";

export function spawnComputeWorker(): Worker {
  return new ComputeWorker();
}
