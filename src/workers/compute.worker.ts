import {
  centralityScores,
  runMetrics,
  type CentralityKind,
  type MetricGraph,
  type MetricOptions,
  type MetricRunResult,
} from "../lib/metrics";
import { runScript, ScriptError } from "../lib/script/quickjs";

/**
 * One worker serves the built-in metrics, the statistics panel's rankings and
 * user scripts. Louvain on a large graph, harmonic closeness on one, and a slow
 * script are the same problem from the main thread's point of view: work that
 * must not happen on it.
 */

export interface MetricsRequest {
  kind: "metrics";
  id: number;
  graph: MetricGraph;
  metrics: string[];
  options: MetricOptions;
}

/**
 * One ranking over one graph, for the statistics panel. Separate from the
 * metrics request because nothing is written back to the document: the answer
 * is a column of numbers the panel sorts by and then forgets.
 */
export interface CentralityRequest {
  kind: "centrality";
  id: number;
  graph: MetricGraph;
  centrality: CentralityKind;
}

export interface ScriptRequest {
  kind: "script";
  id: number;
  code: string;
  payload: unknown;
  deadlineMs: number;
  memoryBytes: number;
}

export type WorkerRequest = MetricsRequest | CentralityRequest | ScriptRequest;

export type WorkerResponse =
  | { id: number; ok: true; kind: "metrics"; result: MetricRunResult; elapsedMs: number }
  | {
      id: number;
      ok: true;
      kind: "centrality";
      scores: [string, number][];
      elapsedMs: number;
    }
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

  if (request.kind === "metrics" || request.kind === "centrality") {
    try {
      const message: WorkerResponse =
        request.kind === "metrics"
          ? {
              id: request.id,
              ok: true,
              kind: "metrics",
              result: runMetrics(request.graph, request.metrics, request.options),
              elapsedMs: performance.now() - started,
            }
          : {
              id: request.id,
              ok: true,
              kind: "centrality",
              scores: [...centralityScores(request.graph, request.centrality)],
              elapsedMs: performance.now() - started,
            };
      ctx.postMessage(message);
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
