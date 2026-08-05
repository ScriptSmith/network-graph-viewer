import type { CellValue } from "../types";
import { sample, table } from "./build";

/**
 * A generated social network at renderer-testing scale: thousands of members,
 * each joining one interest community and following earlier members. Follows
 * are drawn by preferential attachment, mostly within the member's own
 * community, so the graph settles into visible clusters around a few heavily
 * followed accounts. The generator is seeded, so the network is the same
 * every time, and it is the one sample big enough that the app suggests a
 * renderer before drawing it.
 */
const COMMUNITIES: [name: string, weight: number][] = [
  ["Photography", 14],
  ["Cycling", 12],
  ["Gardening", 11],
  ["Astronomy", 8],
  ["Baking", 10],
  ["Climbing", 8],
  ["Film", 12],
  ["Synths", 6],
  ["Birdwatching", 7],
  ["Ceramics", 6],
  ["Chess", 9],
  ["Trail running", 9],
];

const MEMBERS = 7500;
/** Chance that a follow leaves the member's own community. */
const CROSS = 0.08;
/** Chance a follow ignores popularity and lands on anyone, for spread. */
const UNIFORM = 0.25;

/** mulberry32: 32-bit integer maths only, so the sequence never drifts. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Handles rather than names: real enough to read, and the trailing number is
 * what keeps thousands of them unique without a collision check. Drawn from a
 * generator of their own: sharing the network's would shift its sequence and
 * change every edge.
 */
const ADJECTIVES = [
  "amber",
  "brisk",
  "cedar",
  "dusty",
  "early",
  "feral",
  "glass",
  "hazel",
  "inland",
  "juniper",
  "kindly",
  "lunar",
  "mossy",
  "nimble",
  "ochre",
  "pale",
  "quiet",
  "rusty",
  "silver",
  "tidal",
];

const CREATURES = [
  "heron",
  "otter",
  "lynx",
  "wren",
  "badger",
  "falcon",
  "newt",
  "ibis",
  "marten",
  "plover",
  "stoat",
  "swift",
  "vole",
  "curlew",
  "pike",
  "shrike",
  "dormouse",
  "kestrel",
  "lapwing",
  "teal",
];

function build(): { edges: CellValue[][]; nodes: CellValue[][] } {
  const rand = seeded(20250803);
  const handles = seeded(19391101);
  const pick = (list: string[]) => list[Math.floor(handles() * list.length)];
  const totalWeight = COMMUNITIES.reduce((sum, c) => sum + c[1], 0);

  const handle: string[] = [];
  const community: string[] = [];
  /** Member indices of each community, for the uniform picks. */
  const rosters = new Map<string, number[]>();
  for (const [name] of COMMUNITIES) rosters.set(name, []);
  for (let i = 0; i < MEMBERS; i++) {
    handle.push(`${pick(ADJECTIVES)}-${pick(CREATURES)}-${i + 1}`);
    let roll = rand() * totalWeight;
    let chosen = COMMUNITIES[COMMUNITIES.length - 1][0];
    for (const [name, weight] of COMMUNITIES) {
      roll -= weight;
      if (roll <= 0) {
        chosen = name;
        break;
      }
    }
    community.push(chosen);
  }

  // Every follow lands its target here, so sampling the array is sampling by
  // followers: the rich-get-richer draw, in constant time per edge rather
  // than a scan of everyone. One pool per community and one for the whole
  // network, because a follow usually stays home and sometimes wanders.
  const pools = new Map<string, number[]>();
  for (const [name] of COMMUNITIES) pools.set(name, []);
  const globalPool: number[] = [];

  const edges: CellValue[][] = [];
  for (let i = 0; i < MEMBERS; i++) {
    rosters.get(community[i])?.push(i);
    if (i === 0) continue;
    // Skewed low: most members follow a couple of accounts, a few follow many.
    const follows = 1 + Math.floor(rand() * rand() * 8);
    const taken = new Set<number>([i]);
    for (let f = 0; f < follows; f++) {
      const home = rand() >= CROSS;
      const pool = home ? (pools.get(community[i]) ?? []) : globalPool;
      const roster = home ? (rosters.get(community[i]) ?? []) : null;
      let target = -1;
      // A handful of draws, then give up on this follow: a duplicate draw is
      // common around the hubs, and a bounded retry keeps the build linear.
      for (let attempt = 0; attempt < 8 && target === -1; attempt++) {
        let candidate: number | undefined;
        if (pool.length > 0 && rand() >= UNIFORM) {
          candidate = pool[Math.floor(rand() * pool.length)];
        } else if (roster !== null && roster.length > 1) {
          candidate = roster[Math.floor(rand() * (roster.length - 1))];
        } else {
          candidate = Math.floor(rand() * i);
        }
        if (candidate !== undefined && candidate < i && !taken.has(candidate)) {
          target = candidate;
        }
      }
      if (target === -1) continue;
      taken.add(target);
      pools.get(community[target])?.push(target);
      globalPool.push(target);
      // How often the pair actually interacts, heavy-tailed like everything
      // else here: most follows are quiet, a few are conversations.
      const interactions = 1 + Math.floor(rand() * rand() * 60);
      edges.push([handle[i], handle[target], interactions]);
    }
  }

  return {
    edges,
    nodes: handle.map((h, i) => [h, community[i]]),
  };
}

const { edges, nodes } = build();

export const SOCIAL = sample({
  id: "social",
  name: "Social network",
  blurb:
    "Generated: 7,500 members across a dozen communities, following earlier arrivals by preferential attachment. Big enough that the SVG renderer is the wrong tool, which makes it the one to try Canvas and WebGL on.",
  dataset: {
    fileName: "sample-social-network",
    tables: [
      table("Follows", ["Follower", "Followed", "Interactions"], edges),
      table("Members", ["Member", "Community"], nodes),
    ],
  },
  nodeTable: 1,
  style: {
    nodeColor: "column:Community",
    nodeSize: "metric:in",
  },
});
