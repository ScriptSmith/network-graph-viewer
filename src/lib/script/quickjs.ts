import type { QuickJSWASMModule } from "quickjs-emscripten-core";

/**
 * User scripts run inside QuickJS compiled to WebAssembly, not in this realm.
 *
 * That buys three things `new Function` cannot: an interrupt handler, so an
 * infinite loop unwinds at a deadline instead of wedging the thread; a memory
 * ceiling, so a runaway allocation throws instead of taking the tab with it;
 * and a global scope that starts empty, so there is no `fetch`, no DOM and no
 * storage to reach for rather than a list of globals to remember to delete.
 *
 * It is not a defence against a determined attacker whose script you chose to
 * paste and run. It stops accidents and exfiltration, and that is the claim.
 */

const DEFAULT_DEADLINE_MS = 3000;
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_STACK_BYTES = 1024 * 1024;

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/**
 * The engine is ~500 KB of WebAssembly, so it is fetched the first time a
 * script actually runs and never for anyone who does not write one.
 */
async function engine(): Promise<QuickJSWASMModule> {
  modulePromise ??= (async () => {
    const [core, variant] = await Promise.all([
      import("quickjs-emscripten-core"),
      import("@jitl/quickjs-wasmfile-release-sync"),
    ]);
    return core.newQuickJSWASMModuleFromVariant(variant.default);
  })();
  return modulePromise;
}

export interface ScriptOptions {
  deadlineMs?: number;
  memoryBytes?: number;
}

/**
 * Math.random and the clock are replaced with fixed, seeded versions. A metric
 * or layout that changes every time you press Run is worse than useless when
 * the result becomes a column you filter and style by.
 */
const PRELUDE = `
globalThis.Math.random = (() => {
  let seed = 0x2545f491;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
})();
globalThis.Date.now = () => 0;
`;

export class ScriptError extends Error {
  detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ScriptError";
    this.detail = detail;
  }
}

/**
 * Run `code` as the body of a function taking `graph` and returning a value.
 * The graph goes in as one JSON string and the result comes back as another:
 * crossing the WebAssembly boundary per node would be slow and would leak
 * handles the moment a dispose was missed.
 */
export async function runScript<T = unknown>(
  code: string,
  payload: unknown,
  options: ScriptOptions = {},
): Promise<T> {
  const QuickJS = await engine();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(options.memoryBytes ?? DEFAULT_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);

  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() <= deadline) return false;
    interrupted = true;
    return true;
  });

  const context = runtime.newContext();
  try {
    const json = context.newString(JSON.stringify(payload));
    context.setProp(context.global, "__GRAPH__", json);
    json.dispose();

    const source = `${PRELUDE}
JSON.stringify((function (graph) {
${code}
})(JSON.parse(__GRAPH__)) ?? null)`;

    const result = context.evalCode(source);
    if (result.error) {
      const dumped = context.dump(result.error) as { name?: string; message?: string } | string;
      result.error.dispose();
      if (interrupted) {
        throw new ScriptError(
          `The script ran longer than ${(options.deadlineMs ?? DEFAULT_DEADLINE_MS) / 1000}s and was stopped.`,
        );
      }
      const detail =
        typeof dumped === "string" ? dumped : `${dumped.name ?? "Error"}: ${dumped.message ?? ""}`;
      throw new ScriptError("The script threw.", detail.trim());
    }

    const text = context.getString(result.value);
    result.value.dispose();
    return JSON.parse(text) as T;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
