/**
 * @vitest-environment jsdom
 *
 * The source lifecycle protocol, against a fake engine: every document
 * arrival releases, cancel mid-start disposes on arrival, load promotes
 * exactly one engine, and a detached recipe reattaches only to its own file.
 */
import { expect, test } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildDoc } from "./lib/doc";
import type { DataSource, MaterializeResult, SourceSchema } from "./lib/source";
import { useSource, checkSourceUrl, type EngineFactory, type SourceApi } from "./useSource";

const SCHEMA: SourceSchema = {
  tables: [
    {
      name: "Edges",
      columns: [
        { name: "src", type: "text" },
        { name: "dst", type: "text" },
      ],
      rowCount: 3,
    },
  ],
};

interface Fake {
  source: DataSource;
  disposed: () => boolean;
}

function fakeSource(options: { rows?: Record<string, string>[] } = {}): Fake {
  let disposed = false;
  const rows = options.rows ?? [{ src: "a", dst: "b" }];
  const source: DataSource = {
    kind: "native",
    async schema() {
      return SCHEMA;
    },
    async distinct() {
      return [];
    },
    async range() {
      return null;
    },
    async bins() {
      return null;
    },
    async nodeCount() {
      return { value: 2, approximate: false };
    },
    async searchNodes() {
      return [];
    },
    async lookupIds() {
      return [];
    },
    async neighborhood() {
      return { hops: [], nodes: 0, edges: 0, truncated: false };
    },
    async materialize(selection): Promise<MaterializeResult> {
      const doc = buildDoc(
        "fake",
        { name: "Edges", columns: SCHEMA.tables[0].columns, rows: [...rows] },
        { mapping: { source: selection.source, target: selection.target, attrs: [] } },
      );
      return { doc };
    },
    dispose() {
      disposed = true;
    },
  };
  return { source, disposed: () => disposed };
}

/** Rows enough to blow the working-set limit when extrapolated. */
function hugeCsv(name = "big.csv"): File {
  return new File(["a,b\n".repeat(250_000)], name);
}

function mount(engineFor: EngineFactory): { api: () => SourceApi; root: Root } {
  const holder: { current: SourceApi | null } = { current: null };
  function Probe() {
    holder.current = useSource({ engineFor });
    return null;
  }
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<Probe />);
  });
  return { api: () => holder.current!, root };
}

test("a file under the limit is declined without starting an engine", async () => {
  let asked = 0;
  const { api, root } = mount(async () => {
    asked++;
    return fakeSource().source;
  });
  let claimed = true;
  await act(async () => {
    claimed = await api().open(new File(["a,b\n".repeat(10)], "small.csv"));
  });
  expect(claimed).toBe(false);
  expect(asked).toBe(0);
  expect(api().pending).toBeNull();
  act(() => root.unmount());
});

test("an over-limit file opens pending, endpoints defaulted off the schema", async () => {
  const fake = fakeSource();
  const { api, root } = mount(async () => fake.source);
  let claimed = false;
  await act(async () => {
    claimed = await api().open(hugeCsv());
  });
  expect(claimed).toBe(true);
  expect(api().opening).toBe(false);
  expect(api().pending?.name).toBe("big.csv");
  expect(api().pending?.selection.source).toBe("src");
  expect(api().pending?.selection.target).toBe("dst");
  expect(api().pending?.selection.depth).toBe(1);

  // Cancel backs out and lets the engine go.
  act(() => api().cancel());
  expect(api().pending).toBeNull();
  expect(fake.disposed()).toBe(true);
  act(() => root.unmount());
});

test("load promotes the pending engine to live and hands back the working set", async () => {
  const fake = fakeSource();
  const { api, root } = mount(async () => fake.source);
  await act(async () => {
    await api().open(hugeCsv());
  });
  const out: { result: MaterializeResult | null } = { result: null };
  await act(async () => {
    out.result = await api().load();
  });
  expect(out.result?.doc.edges.rows).toHaveLength(1);
  expect(api().pending).toBeNull();
  expect(api().live?.source).toBe(fake.source);
  expect(api().liveRef.current?.source).toBe(fake.source);
  expect(fake.disposed()).toBe(false);

  // Release is what every later arrival calls; the engine goes with it.
  act(() => api().release());
  expect(api().live).toBeNull();
  expect(api().liveRef.current).toBeNull();
  expect(fake.disposed()).toBe(true);
  act(() => root.unmount());
});

test("an empty selection reports instead of promoting", async () => {
  const fake = fakeSource({ rows: [] });
  const { api, root } = mount(async () => fake.source);
  await act(async () => {
    await api().open(hugeCsv());
  });
  let result: MaterializeResult | null = null;
  await act(async () => {
    result = await api().load();
  });
  expect(result).toBeNull();
  expect(api().pendingError).toContain("empty");
  // The pending source survives so the reader can widen and try again.
  expect(api().pending).not.toBeNull();
  expect(api().live).toBeNull();
  expect(fake.disposed()).toBe(false);
  act(() => root.unmount());
});

test("cancel during engine startup disposes the engine when it arrives", async () => {
  const fake = fakeSource();
  let releaseEngine: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseEngine = resolve;
  });
  const { api, root } = mount(async () => {
    await gate;
    return fake.source;
  });

  let claimed: Promise<boolean> | null = null;
  await act(async () => {
    claimed = api().open(hugeCsv());
    // The probe resolves before the engine; give it a beat, then cancel
    // while the start is still in flight.
    await Promise.resolve();
  });
  act(() => api().cancel());
  await act(async () => {
    releaseEngine?.();
    await claimed;
  });
  expect(api().pending).toBeNull();
  expect(fake.disposed()).toBe(true);
  act(() => root.unmount());
});

test("loading a second source disposes the live engine it replaces", async () => {
  const first = fakeSource();
  const second = fakeSource();
  const engines = [first, second];
  const { api, root } = mount(async () => engines.shift()!.source);

  await act(async () => {
    await api().open(hugeCsv("one.csv"));
    await api().load();
  });
  expect(api().live?.source).toBe(first.source);

  await act(async () => {
    await api().open(hugeCsv("two.csv"));
  });
  // Opening alone must not touch the live engine; the reader may cancel.
  expect(first.disposed()).toBe(false);
  await act(async () => {
    await api().load();
  });
  expect(api().live?.source).toBe(second.source);
  expect(first.disposed()).toBe(true);
  expect(second.disposed()).toBe(false);
  act(() => root.unmount());
});

test("reload updates the live selection and keeps the engine on failure", async () => {
  const fake = fakeSource();
  fake.source.materialize = async (selection) => {
    if (selection.seeds.includes("missing")) throw new Error("no such node");
    const doc = buildDoc(
      "fake",
      {
        name: "Edges",
        columns: SCHEMA.tables[0].columns,
        rows: [{ src: "a", dst: "b" }],
      },
      { mapping: { source: selection.source, target: selection.target, attrs: [] } },
    );
    return { doc };
  };
  const { api, root } = mount(async () => fake.source);
  await act(async () => {
    await api().open(hugeCsv());
    await api().load();
  });

  const wider = { ...api().live!.selection, seeds: ["a"] };
  await act(async () => {
    await api().reload(wider);
  });
  expect(api().live?.selection.seeds).toEqual(["a"]);

  const broken = { ...api().live!.selection, seeds: ["missing"] };
  await act(async () => {
    await api().reload(broken);
  });
  expect(api().liveError).toContain("no such node");
  expect(api().live?.selection.seeds).toEqual(["a"]);
  expect(fake.disposed()).toBe(false);
  act(() => root.unmount());
});

test("a detached recipe reattaches only to its own file", async () => {
  const fake = fakeSource();
  const { api, root } = mount(async () => fake.source);
  const file = new File(["x"], "saved.csv");
  const saved = {
    ref: { kind: "file" as const, name: "saved.csv", size: file.size },
    selection: {
      table: "Edges",
      source: "src",
      target: "dst",
      seeds: ["a"],
      depth: 2,
      direction: "any" as const,
      edgeLimit: 1000,
    },
  };
  act(() => api().restore(saved));
  expect(api().detached).toEqual(saved);
  expect(api().liveRef.current).toBeNull();

  await act(async () => {
    await api().reattach(new File(["yy"], "other.csv"));
  });
  expect(api().live).toBeNull();
  expect(api().liveError).toContain("saved.csv");

  await act(async () => {
    await api().reattach(file);
  });
  expect(api().live?.selection).toEqual(saved.selection);
  expect(api().detached).toBeNull();

  // Release clears a detached recipe too: it described the old document.
  act(() => api().restore(saved));
  act(() => api().release());
  expect(api().detached).toBeNull();
  act(() => root.unmount());
});

test("openUrl refuses credentials and bad schemes, and names CORS on failure", async () => {
  const { api, root } = mount(async () => {
    throw new Error("Failed to fetch");
  });
  await expect(api().openUrl("ftp://example.com/x.csv")).rejects.toThrow(/http/);
  await expect(api().openUrl("https://user:pw@example.com/x.csv")).rejects.toThrow(/credential/i);
  await act(async () => {
    await expect(api().openUrl("https://example.com/edges.parquet")).rejects.toThrow(/CORS/);
  });
  expect(api().pending).toBeNull();
  act(() => root.unmount());
});

test("checkSourceUrl mirrors the workspace validator's rules", () => {
  expect(checkSourceUrl("https://example.com/a.parquet")).toBeNull();
  expect(checkSourceUrl("http://example.com/a.csv")).toBeNull();
  expect(checkSourceUrl("not a url")).not.toBeNull();
  expect(checkSourceUrl("file:///etc/passwd")).not.toBeNull();
  expect(checkSourceUrl("https://a:b@example.com/x")).not.toBeNull();
});
