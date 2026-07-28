import type { Dataset, Row } from "./types";
import { inferColumns } from "./lib/parse";

/**
 * Sample dataset: a supervision network for a fictional ~30 person company.
 * Each row is one Supervisor -> Supervisee edge with attributes on the edge.
 * A few people have a second, dotted-line supervisor so the graph is a true
 * network rather than a clean tree.
 */
const columns = [
  "Supervisor",
  "Supervisee",
  "Department",
  "Relationship",
  "Cadence",
  "Meetings per month",
  "Years together",
];

// prettier-ignore
const raw: [string, string, string, string, string, number, number][] = [
  // Executive layer
  ['Alex Rivera', 'Priya Sharma', 'Engineering', 'Direct', 'Weekly', 4, 5.5],
  ['Alex Rivera', 'Marcus Bell', 'Product', 'Direct', 'Weekly', 4, 4],
  ['Alex Rivera', 'Dana Whitfield', 'Sales', 'Direct', 'Weekly', 4, 6],
  ['Alex Rivera', 'Kenji Mori', 'Operations', 'Direct', 'Biweekly', 2, 3],
  ['Marcus Bell', 'Sofia Lindqvist', 'Design', 'Direct', 'Weekly', 4, 2.5],
  // Engineering leads
  ['Priya Sharma', 'Tomás Ferreira', 'Engineering', 'Direct', 'Weekly', 4, 4.5],
  ['Priya Sharma', 'Grace Okafor', 'Engineering', 'Direct', 'Weekly', 4, 3],
  ['Priya Sharma', 'Yuki Tanaka', 'Engineering', 'Direct', 'Weekly', 4, 2],
  // Platform team
  ['Tomás Ferreira', 'Ben Carter', 'Engineering', 'Direct', 'Weekly', 4, 1.5],
  ['Tomás Ferreira', 'Aisha Khan', 'Engineering', 'Direct', 'Weekly', 4, 3],
  ['Tomás Ferreira', 'Viktor Petrov', 'Engineering', 'Direct', 'Biweekly', 2, 0.5],
  // Frontend team
  ['Grace Okafor', 'Lena Fischer', 'Engineering', 'Direct', 'Weekly', 4, 2],
  ['Grace Okafor', 'Diego Santos', 'Engineering', 'Direct', 'Weekly', 4, 1],
  ['Grace Okafor', 'Mei Chen', 'Engineering', 'Direct', 'Weekly', 4, 2.5],
  // Data team
  ['Yuki Tanaka', 'Sam Whitaker', 'Engineering', 'Direct', 'Weekly', 4, 1],
  ['Yuki Tanaka', 'Ingrid Larsen', 'Engineering', 'Direct', 'Biweekly', 2, 1.5],
  ['Yuki Tanaka', 'Omar Haddad', 'Engineering', 'Direct', 'Weekly', 4, 0.5],
  // Product
  ['Marcus Bell', 'Rachel Adler', 'Product', 'Direct', 'Weekly', 4, 3.5],
  ['Marcus Bell', 'Josh Kim', 'Product', 'Direct', 'Weekly', 4, 1],
  // Design
  ['Sofia Lindqvist', 'Nadia Rossi', 'Design', 'Direct', 'Weekly', 4, 2],
  ['Sofia Lindqvist', 'Tom Nguyen', 'Design', 'Direct', 'Biweekly', 2, 1.5],
  ['Sofia Lindqvist', 'Carla Mendes', 'Design', 'Direct', 'Weekly', 4, 0.5],
  // Sales
  ['Dana Whitfield', 'Robert Hayes', 'Sales', 'Direct', 'Weekly', 4, 5],
  ['Robert Hayes', 'Emily Stanton', 'Sales', 'Direct', 'Weekly', 4, 2],
  ['Robert Hayes', 'Lucas Meyer', 'Sales', 'Direct', 'Weekly', 4, 1.5],
  ['Robert Hayes', 'Zoe Park', 'Sales', 'Direct', 'Biweekly', 2, 1],
  ['Robert Hayes', 'Daniel Osei', 'Sales', 'Direct', 'Biweekly', 2, 0.5],
  // Operations
  ['Kenji Mori', 'Hannah Weiss', 'Operations', 'Direct', 'Weekly', 4, 2.5],
  ['Kenji Mori', 'Arjun Mehta', 'Operations', 'Direct', 'Weekly', 4, 4],
  ['Hannah Weiss', 'Paulo Silva', 'Operations', 'Direct', 'Biweekly', 2, 1],
  ['Arjun Mehta', 'Nina Kovács', 'Operations', 'Direct', 'Weekly', 4, 2],
  // Dotted lines: cross-team supervision that makes this a network, not a tree
  ['Rachel Adler', 'Mei Chen', 'Engineering', 'Dotted line', 'Monthly', 1, 1],
  ['Grace Okafor', 'Carla Mendes', 'Design', 'Dotted line', 'Monthly', 1, 0.5],
  ['Arjun Mehta', 'Omar Haddad', 'Engineering', 'Dotted line', 'Monthly', 1, 0.5],
  ['Sofia Lindqvist', 'Josh Kim', 'Product', 'Dotted line', 'Monthly', 1, 1],
]

const rows: Row[] = raw.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));

export const SAMPLE_DATASET: Dataset = {
  fileName: "sample-supervision-network",
  tables: [{ name: "Supervision", columns: inferColumns(rows, columns), rows }],
};
