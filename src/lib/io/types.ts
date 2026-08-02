import type { GraphDoc, GraphStyle } from "../../types";

export interface Position {
  x: number;
  y: number;
}

/** What every importer returns: a document, and positions if the file had any. */
export interface ImportedGraph {
  doc: GraphDoc;
  positions?: Map<string, Position>;
  /**
   * Appearance the file settled rather than left to be guessed, laid over
   * `guessStyle` on arrival. A format only says anything here when it states
   * something the columns cannot: DOT's undirected `graph`, for one.
   */
  style?: Partial<GraphStyle>;
}
