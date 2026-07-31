import type { WorkerRequest, WorkerResponse } from "../../workers/compute.worker";
import { spawnComputeWorker } from "#worker";
import {
  centralityScores,
  runMetrics,
  type CentralityKind,
  type MetricGraph,
  type MetricOptions,
  type MetricRunResult,
} from "./index";

export interface MetricRun {
  result: MetricRunResult;
  elapsedMs: number;
  /** False when the worker was unavailable and the main thread did the work. */
  offMainThread: boolean;
}

export interface ScriptRun {
  result: unknown;
  elapsedMs: number;
}

interface Pending {
  resolve: (message: Extract<WorkerResponse, { ok: true }>) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker || workerUnavailable) return worker;
  try {
    worker = spawnComputeWorker();
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message);
      else {
        const error = new Error(message.error);
        if (message.detail) error.cause = message.detail;
        entry.reject(error);
      }
    });
    worker.addEventListener("error", (event) => {
      // A worker-level failure kills every request it was carrying; later runs
      // fall back to the main thread rather than hanging forever.
      const error = new Error(event.message || "The compute worker failed.");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
      workerUnavailable = true;
    });
  } catch {
    workerUnavailable = true;
    worker = null;
  }
  return worker;
}

function send(request: WorkerRequest): Promise<Extract<WorkerResponse, { ok: true }>> {
  const active = ensureWorker();
  if (!active) return Promise.reject(new Error("no-worker"));
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject });
    try {
      active.postMessage(request);
    } catch (e) {
      pending.delete(request.id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Compute metrics off the main thread when the browser allows it. Louvain and
 * betweenness on a large graph take long enough to drop frames, and the panel
 * stays responsive only if they run somewhere else.
 */
export async function computeMetrics(
  graph: MetricGraph,
  metrics: string[],
  options: MetricOptions,
): Promise<MetricRun> {
  const request: WorkerRequest = { kind: "metrics", id: nextId++, graph, metrics, options };
  try {
    const message = await send(request);
    if (message.kind !== "metrics") throw new Error("Unexpected reply from the compute worker.");
    return { result: message.result, elapsedMs: message.elapsedMs, offMainThread: true };
  } catch {
    const started = performance.now();
    const result = runMetrics(graph, metrics, options);
    return { result, elapsedMs: performance.now() - started, offMainThread: false };
  }
}

/**
 * One ranking, off the main thread.
 *
 * The statistics panel offers every centrality it knows, and two of them cost
 * a breadth-first search per node. Computed where the panel renders, picking
 * "Harmonic closeness" on a graph of any size would stop the page rather than
 * rank it, so the work goes to the worker and the panel waits.
 *
 * Unlike `computeMetrics` this only falls back to the main thread when there is
 * no worker to be had. A worker that ran and threw has already told us the
 * answer is not coming; running the same computation here would freeze the page
 * on the way to the same error.
 */
export async function computeCentrality(
  graph: MetricGraph,
  kind: CentralityKind,
): Promise<Map<string, number>> {
  const request: WorkerRequest = { kind: "centrality", id: nextId++, graph, centrality: kind };
  try {
    const message = await send(request);
    if (message.kind !== "centrality") throw new Error("Unexpected reply from the compute worker.");
    return new Map(message.scores);
  } catch (e) {
    if (e instanceof Error && e.message === "no-worker") return centralityScores(graph, kind);
    throw e;
  }
}

export interface RunScriptOptions {
  deadlineMs?: number;
  memoryBytes?: number;
}

/**
 * Run a user script. Unlike metrics this has no main-thread fallback: the
 * whole point of the deadline and the memory cap is that the script cannot
 * take the page with it, and running it here would give both up.
 */
export async function runScriptInWorker(
  code: string,
  payload: unknown,
  options: RunScriptOptions = {},
): Promise<ScriptRun> {
  const request: WorkerRequest = {
    kind: "script",
    id: nextId++,
    code,
    payload,
    deadlineMs: options.deadlineMs ?? 3000,
    memoryBytes: options.memoryBytes ?? 64 * 1024 * 1024,
  };
  let message: Extract<WorkerResponse, { ok: true }>;
  try {
    message = await send(request);
  } catch (e) {
    if (e instanceof Error && e.message === "no-worker") {
      throw new Error(
        "Scripts need a Web Worker, which this browser did not provide. Without one there is no way to stop a runaway script.",
      );
    }
    throw e;
  }
  if (message.kind !== "script") throw new Error("Unexpected reply from the compute worker.");
  return { result: message.result, elapsedMs: message.elapsedMs };
}
