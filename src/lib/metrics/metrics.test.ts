import { expect, test } from "vitest";
import { centrality, hits, pagerank } from "./centrality";
import { louvain, louvainStability } from "./community";
import { disparity, embeddedness, simmelian } from "./edges";
import { components, coreness, triangles } from "./structure";
import {
  SAMPLE_LIMIT,
  directed,
  indexOfId,
  shortestPath,
  shortestPathInfo,
  shortestRoutes,
  undirected,
  type MetricGraph,
} from "./model";
import { hopsColumn } from "./index";

/** Build a metric graph from an explicit edge list, with optional weights. */
function graphOf(edges: [string, string, number?][], extraNodes: string[] = []): MetricGraph {
  const ids: string[] = [];
  const index = new Map<string, number>();
  const idOf = (name: string) => {
    let i = index.get(name);
    if (i === undefined) {
      i = ids.length;
      ids.push(name);
      index.set(name, i);
    }
    return i;
  };
  for (const [s, t] of edges) {
    idOf(s);
    idOf(t);
  }
  extraNodes.forEach(idOf);
  return {
    ids,
    source: Int32Array.from(edges.map(([s]) => idOf(s))),
    target: Int32Array.from(edges.map(([, t]) => idOf(t))),
    weight: Float64Array.from(edges.map(([, , w]) => w ?? 1)),
  };
}

const scoresById = (g: MetricGraph, values: ArrayLike<number>) =>
  Object.fromEntries(g.ids.map((id, i) => [id, values[i]]));

/** Every unordered pair among the given names. */
function clique(names: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) out.push([names[i], names[j]]);
  }
  return out;
}

test("PageRank sums to 1 and favours the node everyone points at", () => {
  const g = graphOf([
    ["a", "d"],
    ["b", "d"],
    ["c", "d"],
  ]);
  const scores = scoresById(g, pagerank(g));
  const total = Object.values(scores).reduce((x, y) => x + y, 0);
  expect(total).toBeCloseTo(1, 10);
  expect(scores.d).toBeGreaterThan(scores.a);
  expect(scores.a).toBeCloseTo(scores.b, 10);
});

test("PageRank redistributes dangling mass instead of leaking it", () => {
  // Every node is dangling, so the result must stay a uniform distribution.
  const g = graphOf([["a", "b"]], ["c"]);
  const scores = pagerank(g);
  const total = [...scores].reduce((x, y) => x + y, 0);
  expect(total).toBeCloseTo(1, 10);
});

test("HITS gives a directed star's centre all the authority and no hub score", () => {
  const g = graphOf([
    ["a", "centre"],
    ["b", "centre"],
    ["c", "centre"],
  ]);
  const { hubs, authorities } = hits(g);
  const hub = scoresById(g, hubs);
  const authority = scoresById(g, authorities);
  expect(authority.centre).toBeCloseTo(1, 10);
  expect(authority.a).toBeCloseTo(0, 10);
  expect(hub.centre).toBeCloseTo(0, 10);
  expect(hub.a).toBeCloseTo(1, 10);
});

test("Louvain splits two cliques joined by a single edge", () => {
  const edges: [string, string][] = [
    ...clique(["a1", "a2", "a3", "a4"]),
    ...clique(["b1", "b2", "b3", "b4"]),
    ["a1", "b1"],
  ];
  const { communities, communityCount, modularity } = louvain(graphOf(edges));
  expect(communityCount).toBe(2);
  const g = graphOf(edges);
  const byId = scoresById(g, communities);
  expect(byId.a1).toBe(byId.a2);
  expect(byId.a1).toBe(byId.a4);
  expect(byId.b1).toBe(byId.b4);
  expect(byId.a1).not.toBe(byId.b1);
  expect(modularity).toBeGreaterThan(0.3);
  expect(modularity).toBeLessThan(0.5);
});

test("Louvain is deterministic across runs", () => {
  const edges: [string, string][] = [
    ...clique(["a1", "a2", "a3"]),
    ...clique(["b1", "b2", "b3"]),
    ...clique(["c1", "c2", "c3"]),
    ["a1", "b1"],
    ["b2", "c1"],
  ];
  const first = louvain(graphOf(edges));
  const second = louvain(graphOf(edges));
  expect([...first.communities]).toEqual([...second.communities]);
  expect(first.modularity).toBe(second.modularity);
});

test("Louvain resolution trades community count against size", () => {
  const edges: [string, string][] = [
    ...clique(["a1", "a2", "a3", "a4"]),
    ...clique(["b1", "b2", "b3", "b4"]),
    ["a1", "b1"],
  ];
  const coarse = louvain(graphOf(edges), 0.1);
  const fine = louvain(graphOf(edges), 3);
  expect(coarse.communityCount).toBeLessThanOrEqual(fine.communityCount);
});

test("Louvain handles an edgeless graph without dividing by zero", () => {
  const g = graphOf([], ["a", "b"]);
  const result = louvain(g);
  expect(result.communityCount).toBe(2);
  expect(result.modularity).toBe(0);
});

test("k-core of a clique is one less than its size", () => {
  const g = graphOf(clique(["a", "b", "c", "d"]));
  expect([...coreness(undirected(g))]).toEqual([3, 3, 3, 3]);
});

test("k-core peels a path down to 1 and a pendant off a triangle", () => {
  const path = graphOf([
    ["a", "b"],
    ["b", "c"],
  ]);
  expect([...coreness(undirected(path))]).toEqual([1, 1, 1]);

  const tail = graphOf([...clique(["a", "b", "c"]), ["c", "d"]]);
  const scores = scoresById(tail, coreness(undirected(tail)));
  expect(scores.a).toBe(2);
  expect(scores.d).toBe(1);
});

test("every node of a 4-clique sits in three triangles", () => {
  const g = graphOf(clique(["a", "b", "c", "d"]));
  expect([...triangles(undirected(g))]).toEqual([3, 3, 3, 3]);
});

test("components are numbered largest first", () => {
  const g = graphOf([
    ["a", "b"],
    ["b", "c"],
    ["x", "y"],
  ]);
  const { ids, sizes } = components(undirected(g));
  expect(sizes).toEqual([3, 2]);
  const byId = scoresById(g, ids);
  expect(byId.a).toBe(0);
  expect(byId.x).toBe(1);
});

test("betweenness finds the broker on a path and ignores the ends", () => {
  const g = graphOf([
    ["a", "b"],
    ["b", "c"],
  ]);
  const scores = scoresById(g, centrality(g, "betweenness"));
  expect(scores.b).toBeGreaterThan(0);
  expect(scores.a).toBeCloseTo(0, 10);
  expect(scores.c).toBeCloseTo(0, 10);
});

test("embeddedness counts shared neighbours", () => {
  const g = graphOf(clique(["a", "b", "c"]));
  expect([...embeddedness(g)]).toEqual([1, 1, 1]);

  const open = graphOf([
    ["a", "b"],
    ["b", "c"],
  ]);
  expect([...embeddedness(open)]).toEqual([0, 0]);
});

test("Simmelian strength needs reciprocated ties, so a one-way triangle scores zero", () => {
  const oneWay = graphOf([
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
  ]);
  expect([...simmelian(oneWay)]).toEqual([0, 0, 0]);

  const mutual = graphOf([
    ["a", "b"],
    ["b", "a"],
    ["b", "c"],
    ["c", "b"],
    ["a", "c"],
    ["c", "a"],
  ]);
  expect([...simmelian(mutual)]).toEqual([1, 1, 1, 1, 1, 1]);
});

test("the disparity filter marks a dominant edge as significant and a uniform one as not", () => {
  // The hub spreads weight evenly over four edges except for one heavy tie.
  const g = graphOf([
    ["hub", "heavy", 100],
    ["hub", "light1", 1],
    ["hub", "light2", 1],
    ["hub", "light3", 1],
    // Give every leaf a second tie so none of them is degree one.
    ["heavy", "other", 1],
    ["light1", "other", 1],
    ["light2", "other", 1],
    ["light3", "other", 1],
  ]);
  const alpha = disparity(g);
  expect(alpha[0]).toBeLessThan(0.05);
  expect(alpha[1]).toBeGreaterThan(alpha[0]);
});

test("a degree-one endpoint always keeps its edge", () => {
  const g = graphOf([
    ["a", "b"],
    ["b", "c"],
    ["b", "d"],
  ]);
  // Every leaf has degree one, so each edge is maximally significant.
  expect([...disparity(g)]).toEqual([0, 0, 0]);
});

/**
 * Closeness samples its BFS sources above `SAMPLE_LIMIT`. Below it the sample
 * is every node, and the result has to be the textbook formula exactly rather
 * than an estimate that merely converges on it, or every graph anyone actually
 * loads would be reading a slightly wrong number.
 */
test("closeness on a path graph is exact", () => {
  // A-B-C-D. From A the distances are 1, 2, 3: reach 3/3, mean 2, so 0.5.
  const graph = graphOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
  ]);
  expect([...centrality(graph, "closeness")]).toEqual([0.5, 0.75, 0.75, 0.5]);
});

test("harmonic closeness on a path graph is exact", () => {
  const graph = graphOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
  ]);
  const scores = centrality(graph, "harmonic");
  expect(scores[0]).toBeCloseTo((1 + 1 / 2 + 1 / 3) / 3, 10);
  expect(scores[1]).toBeCloseTo((1 + 1 + 1 / 2) / 3, 10);
});

test("closeness on a disconnected graph does not reward the small island", () => {
  // A triangle and a single pair. Everyone reaches their own component in one
  // step, so only the Wasserman-Faust reach term separates them.
  const graph = graphOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
    ["X", "Y"],
  ]);
  const scores = centrality(graph, "closeness");
  expect(scores[0]).toBeCloseTo(2 / 4, 10);
  expect(scores[3]).toBeCloseTo(1 / 4, 10);
});

test("closeness past the sampling limit stays finite and keeps the hub on top", () => {
  const n = SAMPLE_LIMIT * 3;
  const spokes = Array.from({ length: n - 1 }, (_, i) => ["hub", `n${i}`] as [string, string]);
  const scores = centrality(graphOf(spokes), "closeness");
  expect([...scores].every((s) => isFinite(s) && s > 0)).toBe(true);
  // The hub is index 0: it reaches everyone in one step and must outrank them.
  expect([...scores].slice(1).every((s) => s < scores[0])).toBe(true);
});

test("shortestPath walks hops, ignores direction, and reports the dead ends", () => {
  const graph = graphOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
    ["A", "E"],
    ["E", "D"],
    ["X", "Y"],
  ]);
  // The two-hop route through E beats the three-hop one through B and C.
  expect(shortestPath(graph, "A", "D")).toEqual(["A", "E", "D"]);

  // Direction does not gate the walk: every edge above points one way.
  expect(shortestPath(graph, "D", "A")).toEqual(["D", "E", "A"]);

  // A node reaches itself in zero hops, a stranger not at all.
  expect(shortestPath(graph, "A", "A")).toEqual(["A"]);
  expect(shortestPath(graph, "A", "X")).toBeNull();
  expect(shortestPath(graph, "A", "nobody")).toBeNull();
});

test("shortestPath is unmoved by parallel edges", () => {
  const graph = graphOf([
    ["A", "B"],
    ["A", "B"],
    ["B", "A"],
    ["B", "C"],
  ]);
  expect(shortestPath(graph, "A", "C")).toEqual(["A", "B", "C"]);
});

test("hopsColumn writes distances and leaves the unreachable blank", () => {
  const graph = graphOf(
    [
      ["A", "B"],
      ["B", "C"],
    ],
    ["lonely"],
  );
  const column = hopsColumn(graph, "A", "Hops from A");
  expect(column).not.toBeNull();
  const values = (column as NonNullable<typeof column>).values;
  expect(values.A).toBe(0);
  expect(values.B).toBe(1);
  expect(values.C).toBe(2);
  expect(values.lonely).toBeNull();
  expect(hopsColumn(graph, "nobody", "x")).toBeNull();
});

test("stability is 1 in the cores and lower on the node both sides can claim", () => {
  // Two triangles, and a bridge node tied equally to one corner of each: the
  // cores belong where they belong, the bridge can land either way.
  const edges: [string, string][] = [
    ...clique(["a1", "a2", "a3"]),
    ...clique(["b1", "b2", "b3"]),
    ["a1", "m"],
    ["m", "b1"],
  ];
  const g = graphOf(edges);
  const canonical = louvain(g);
  const stability = louvainStability(g, 1, canonical.communities);
  const byId = scoresById(g, stability);
  expect(byId.a1).toBe(1);
  expect(byId.a2).toBe(1);
  expect(byId.b1).toBe(1);
  expect(byId.b3).toBe(1);
  expect(byId.m).toBeLessThan(1);
});

test("stability is deterministic across invocations", () => {
  const edges: [string, string][] = [
    ...clique(["a1", "a2", "a3", "a4"]),
    ...clique(["b1", "b2", "b3", "b4"]),
    ["a1", "b1"],
  ];
  const g = graphOf(edges);
  const canonical = louvain(g).communities;
  const first = louvainStability(g, 1, canonical);
  const second = louvainStability(g, 1, canonical);
  expect([...first]).toEqual([...second]);
});

test("a permuted visit order still finds the same clean split", () => {
  const edges: [string, string][] = [
    ...clique(["a1", "a2", "a3", "a4"]),
    ...clique(["b1", "b2", "b3", "b4"]),
    ["a1", "b1"],
  ];
  const g = graphOf(edges);
  const n = g.ids.length;
  const reversed = Int32Array.from({ length: n }, (_, i) => n - 1 - i);
  const plain = louvain(g);
  const shuffled = louvain(g, 1, reversed);
  expect(shuffled.communityCount).toBe(plain.communityCount);
  // Same partition up to labels: nodes grouped together stay together.
  const key = (r: { communities: Int32Array }) =>
    g.ids.map((_, i) => r.communities[i] === r.communities[0]);
  expect(key(shuffled)).toEqual(key(plain));
});

test("shortestPathInfo counts the equally short routes", () => {
  // Two two-hop routes from A to D, via B or via C.
  const g = graphOf([
    ["A", "B"],
    ["A", "C"],
    ["B", "D"],
    ["C", "D"],
  ]);
  const info = shortestPathInfo(g, "A", "D");
  expect(info?.path).toHaveLength(3);
  expect(info?.count).toBe(2);
  // A single chain is the only route this short.
  expect(shortestPathInfo(g, "A", "B")?.count).toBe(1);
});

test("a directed walk follows the arrows and can fail where undirected succeeds", () => {
  const g = graphOf([
    ["A", "B"],
    ["C", "B"],
    ["C", "D"],
  ]);
  // Undirected, A reaches D in three hops through B and C.
  expect(shortestPathInfo(g, "A", "D")?.path).toEqual(["A", "B", "C", "D"]);
  // Along the arrows, B has no way out, so there is no route at all.
  expect(shortestPathInfo(g, "A", "D", { directed: true })).toBeNull();

  const ring = graphOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
  ]);
  // The arrows force the long way round.
  expect(shortestPathInfo(ring, "A", "C", { directed: true })?.path).toEqual(["A", "B", "C"]);
  expect(shortestPathInfo(ring, "A", "C")?.path).toEqual(["A", "C"]);
});

test("shortestRoutes lists the alternatives, capped and deterministic", () => {
  // Two two-hop routes from A to D, via B or via C, in adjacency order.
  const g = graphOf([
    ["A", "B"],
    ["A", "C"],
    ["B", "D"],
    ["C", "D"],
  ]);
  const info = shortestRoutes(g, "A", "D", { limit: 10 });
  expect(info?.count).toBe(2);
  expect(info?.routes).toEqual([
    ["A", "B", "D"],
    ["A", "C", "D"],
  ]);

  // The cap holds while the count stays honest.
  const capped = shortestRoutes(g, "A", "D", { limit: 1 });
  expect(capped?.routes).toHaveLength(1);
  expect(capped?.count).toBe(2);

  // Same call, same answer.
  expect(shortestRoutes(g, "A", "D", { limit: 10 })).toEqual(info);
});

test("the views are built once per graph and read the same either way", () => {
  const g = graphOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
  ]);
  // A compute run asks several measures of one graph and most of them want the
  // same undirected view, so it is built once. Every consumer treats it as
  // read-only, which is what makes handing the same object back safe.
  expect(undirected(g)).toBe(undirected(g));
  expect(directed(g)).toBe(directed(g));

  // A different graph over the same ids is still its own view.
  const other = graphOf([["A", "B"]]);
  expect(undirected(other)).not.toBe(undirected(g));

  // The id lookup replaces what was a linear scan at every call.
  expect(indexOfId(g, "C")).toBe(2);
  expect(indexOfId(g, "nobody")).toBe(-1);
  expect(g.ids.map((id) => indexOfId(g, id))).toEqual([0, 1, 2]);
});
