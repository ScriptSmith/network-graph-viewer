import { expect, test } from "vitest";
import { centrality, hits, pagerank } from "./centrality";
import { louvain } from "./community";
import { disparity, embeddedness, simmelian } from "./edges";
import { components, coreness, triangles } from "./structure";
import { undirected, type MetricGraph } from "./model";

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
