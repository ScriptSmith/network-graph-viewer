/**
 * The sandbox's promises, as promises rather than as intentions: a deadline a
 * runaway loop cannot outlast, a global scope with nothing in it to reach for,
 * and a clock and a randomness that give the same answer twice. The last one
 * matters because a script's result becomes a column that gets filtered,
 * styled and exported, and a column that changes on every Run is worse than
 * no column at all.
 */
import { expect, test } from "vitest";
import { runScript } from "./quickjs";

test("the clock is pinned, constructor and all", async () => {
  const result = await runScript<Record<string, unknown>>(
    `return {
       now: Date.now(),
       constructed: new Date().getTime(),
       explicit: new Date(2020, 0, 2).getFullYear(),
     };`,
    {},
  );
  expect(result.now).toBe(0);
  // Pinning only Date.now would leave this as a way back to the real clock.
  expect(result.constructed).toBe(0);
  // A date the script asked for by value is still the date it asked for.
  expect(result.explicit).toBe(2020);
});

test("the same script twice gives the same answer", async () => {
  const code = `return { t: new Date().getTime(), r: Math.random(), s: Math.random() };`;
  expect(await runScript(code, {})).toEqual(await runScript(code, {}));
});

test("randomness is still random-looking, just not new each run", async () => {
  const values = await runScript<number[]>(
    `return Array.from({ length: 50 }, () => Math.random());`,
    {},
  );
  expect(values).toHaveLength(50);
  expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  expect(new Set(values).size).toBeGreaterThan(40);
});

test("the graph goes in and the answer comes back", async () => {
  const result = await runScript(`return graph.nodes.map((n) => n.id).sort();`, {
    nodes: [{ id: "b" }, { id: "a" }],
  });
  expect(result).toEqual(["a", "b"]);
});

test("a runaway loop is stopped at the deadline", async () => {
  await expect(runScript(`while (true) {}`, {}, { deadlineMs: 300 })).rejects.toThrow(
    /ran longer than/,
  );
});

test("there is nothing in scope to reach the outside with", async () => {
  const missing = await runScript<string[]>(
    `return ["fetch", "XMLHttpRequest", "localStorage", "document", "WebSocket"]
       .filter((name) => typeof globalThis[name] === "undefined");`,
    {},
  );
  expect(missing).toEqual(["fetch", "XMLHttpRequest", "localStorage", "document", "WebSocket"]);
});

test("a script that throws says what it threw", async () => {
  await expect(runScript(`throw new Error("nope");`, {})).rejects.toThrow(/threw/);
});
