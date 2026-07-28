import {
  runMetrics,
  type MetricGraph,
  type MetricOptions,
  type MetricRunResult,
} from "../lib/metrics";
import { runScript, ScriptError } from "../lib/script/quickjs";

/**
 * One worker serves both the built-in metrics and user scripts. Louvain on a
 * large graph and a slow script are the same problem from the main thread's
 * point of view: work that must not happen on it.
 */

export interface MetricsRequest {
  kind: "metrics";
  id: number;
  graph: MetricGraph;
  metrics: string[];
  options: MetricOptions;
}

export interface ScriptRequest {
  kind: "script";
  id: number;
  code: string;
  payload: unknown;
  deadlineMs: number;
  memoryBytes: number;
}

export type WorkerRequest = MetricsRequest | ScriptRequest;

export type WorkerResponse =
  | { id: number; ok: true; kind: "metrics"; result: MetricRunResult; elapsedMs: number }
  | { id: number; ok: true; kind: "script"; result: unknown; elapsedMs: number }
  | { id: number; ok: false; error: string; detail?: string };

/**
 * The project compiles against the DOM lib, where `self` is a Window and
 * `postMessage` wants a target origin. Narrowing to the shape a worker
 * actually uses keeps this honest without pulling in a conflicting lib.
 */
const ctx = self as unknown as {
  postMessage: (message: WorkerResponse) => void;
  addEventListener: (
    type: "message",
    handler: (event: MessageEvent<WorkerRequest>) => void,
  ) => void;
};

ctx.addEventListener("message", (event) => {
  const request = event.data;
  const started = performance.now();

  if (request.kind === "metrics") {
    try {
      const result = runMetrics(request.graph, request.metrics, request.options);
      ctx.postMessage({
        id: request.id,
        ok: true,
        kind: "metrics",
        result,
        elapsedMs: performance.now() - started,
      });
    } catch (e) {
      ctx.postMessage({
        id: request.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  void runScript(request.code, request.payload, {
    deadlineMs: request.deadlineMs,
    memoryBytes: request.memoryBytes,
  })
    .then((result) => {
      ctx.postMessage({
        id: request.id,
        ok: true,
        kind: "script",
        result,
        elapsedMs: performance.now() - started,
      });
    })
    .catch((e: unknown) => {
      ctx.postMessage({
        id: request.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        detail: e instanceof ScriptError ? e.detail : undefined,
      });
    });
});
