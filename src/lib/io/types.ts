import type { GraphDoc } from "../../types";

export interface Position {
  x: number;
  y: number;
}

/** What every importer returns: a document, and positions if the file had any. */
export interface ImportedGraph {
  doc: GraphDoc;
  positions?: Map<string, Position>;
}
