import type { CellValue } from "../types";
import { sample, table } from "./build";

/**
 * A generated citation network: papers published over twenty years, each
 * citing earlier work, mostly within its own field. Targets are drawn by
 * preferential attachment with a recency bias, which gives the heavy tail
 * real citation counts have: a few papers everyone cites, a long tail nobody
 * does. Edges always point from the newer paper to the older one, so the
 * graph is acyclic. The generator is seeded, so the network is the same every
 * time.
 */
const FIELDS: [code: string, name: string, weight: number][] = [
  ["SYS", "Systems", 22],
  ["THY", "Theory", 14],
  ["VIS", "Vision", 20],
  ["LNG", "Language", 18],
  ["BIO", "Biology", 14],
  ["CLI", "Climate", 12],
];

const COUNT = 600;
const FIRST_YEAR = 2005;
const SPAN = 20;
/** Chance that a citation stays inside the citing paper's own field. */
const SAME_FIELD = 0.72;

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

interface Paper {
  id: string;
  field: string;
  year: number;
  /** Citations received so far, which is what draws the next one. */
  cited: number;
}

function build(): { edges: CellValue[][]; nodes: CellValue[][] } {
  const rand = seeded(20240517);
  const totalWeight = FIELDS.reduce((sum, f) => sum + f[2], 0);

  const papers: Paper[] = [];
  for (let i = 0; i < COUNT; i++) {
    let roll = rand() * totalWeight;
    let field = FIELDS[FIELDS.length - 1];
    for (const candidate of FIELDS) {
      roll -= candidate[2];
      if (roll <= 0) {
        field = candidate;
        break;
      }
    }
    papers.push({
      id: `${field[0]}-${String(i + 1).padStart(3, "0")}`,
      field: field[1],
      year: FIRST_YEAR + Math.min(SPAN - 1, Math.floor((i / COUNT) * SPAN)),
      cited: 0,
    });
  }

  const edges: CellValue[][] = [];
  for (let i = 1; i < COUNT; i++) {
    const citing = papers[i];
    const references = 1 + Math.floor(rand() * 5);
    const taken = new Set<number>();
    for (let r = 0; r < references; r++) {
      const ownFieldOnly = rand() < SAME_FIELD;
      let pool: number[] = [];
      for (let j = 0; j < i; j++) {
        if (taken.has(j)) continue;
        if (ownFieldOnly && papers[j].field !== citing.field) continue;
        pool.push(j);
      }
      // Early papers can run out of same-field ancestors; widen rather than
      // leave a paper citing nothing.
      if (pool.length === 0 && ownFieldOnly) {
        pool = [];
        for (let j = 0; j < i; j++) if (!taken.has(j)) pool.push(j);
      }
      if (pool.length === 0) break;

      let running = 0;
      const cumulative = pool.map((j) => {
        running += (1 + papers[j].cited) / (1 + 0.35 * (citing.year - papers[j].year));
        return running;
      });
      const roll = rand() * running;
      const chosen = pool[cumulative.findIndex((c) => c >= roll)] ?? pool[pool.length - 1];
      taken.add(chosen);
      papers[chosen].cited++;

      const cited = papers[chosen];
      edges.push([citing.id, cited.id, cited.field === citing.field, citing.year - cited.year]);
    }
  }

  return { edges, nodes: papers.map((p) => [p.id, p.field, p.year]) };
}

const { edges, nodes } = build();

export const CITATIONS = sample({
  id: "citations",
  name: "Citation network",
  blurb:
    "Generated: 600 papers over twenty years, each citing earlier work. Large enough to need filtering, with the heavy tail of citation counts that comes with it.",
  dataset: {
    fileName: "sample-citation-network",
    tables: [
      table("Citations", ["Citing paper", "Cited paper", "Same field", "Year gap"], edges),
      table("Papers", ["Paper", "Field", "Year"], nodes),
    ],
  },
  nodeTable: 1,
  style: {
    nodeColor: "column:Field",
    nodeSize: "metric:in",
  },
});
