import { useCallback, useState } from "react";
import type { GraphDoc, Table } from "./types";
import { diffDocs, extendOverlay, EMPTY_OVERLAY, type EditsOverlay } from "./lib/overlay";

/**
 * Undo history over the working document. Every change to the document goes
 * through `edit`, so an undo can never step over work that was recorded
 * nowhere; loading a different file calls `reset` instead, because walking
 * backwards out of one document into another is not a step anyone means.
 *
 * Whole documents are kept rather than diffs. The transforms in lib/edit.ts
 * copy only the rows they touch, so a snapshot usually shares almost
 * everything with the one before it, but column renames, retypes and computed
 * columns rebuild every row object, and fifty snapshots of a large table that
 * each own their rows is how an undo history becomes the biggest thing on the
 * heap. So each entry carries a weight, the row objects it holds that its
 * successor does not share, and the oldest entries are let go once the total
 * passes a budget. A minimum number of steps is always kept whatever they
 * weigh: undo never vanishes, it only stops reaching back so far.
 *
 * The edits overlay rides alongside: each recorded step diffs its before and
 * after documents and folds the delta in, so "update data" can replay the
 * user's work onto a fresh file. It is snapshotted with each entry, which is
 * what makes undo rewind the overlay too. Steps applied with `mode: "keep"`
 * change the document without touching the overlay; replacing the data out
 * from under the edits is exactly that.
 */

/** How many steps back the table remembers, at most. */
const DEPTH = 50;

/** Steps always kept, whatever they weigh. */
export const MIN_DEPTH = 5;

/**
 * Row objects the history may hold beyond what the present document shares.
 * At the current 200k working-set ceiling this is about fifteen whole-table
 * rebuilds; raising the working set is the conversation that would retune it.
 */
export const ROW_BUDGET = 3_000_000;

interface Entry {
  doc: GraphDoc;
  overlay: EditsOverlay;
  /** What was done to leave this document, so a button can name it. */
  label: string;
  /** Row objects this entry keeps alive that its successor does not share. */
  weight: number;
}

/** Rows in `before` that `after` no longer holds, by identity. */
function rowsNotShared(before: Table, after: Table): number {
  if (before.rows === after.rows) return 0;
  const kept = new Set(after.rows);
  let n = 0;
  for (const row of before.rows) if (!kept.has(row)) n++;
  return n;
}

/**
 * What keeping `before` costs beyond keeping `after`: 1 for a cell edit, the
 * whole table for a column op or a computed column, which rebuild every row.
 */
export function entryWeight(before: GraphDoc, after: GraphDoc): number {
  return rowsNotShared(before.edges, after.edges) + rowsNotShared(before.nodes, after.nodes);
}

/**
 * The newest steps that fit: everything up to `DEPTH` while the summed weight
 * stays under budget, and never fewer than `MIN_DEPTH` however heavy they are.
 */
export function trimPast<T extends { weight: number }>(past: T[]): T[] {
  const most = Math.min(past.length, DEPTH);
  let kept = 0;
  let total = 0;
  while (kept < most) {
    total += past[past.length - 1 - kept].weight;
    if (kept >= MIN_DEPTH && total > ROW_BUDGET) break;
    kept++;
  }
  return kept === past.length ? past : past.slice(past.length - kept);
}

interface State {
  past: Entry[];
  present: GraphDoc | null;
  overlay: EditsOverlay;
  future: Entry[];
}

export type EditMode = "record" | "keep";

export interface DocHistory {
  doc: GraphDoc | null;
  /** The user's table work so far, for saving and for update-data merges. */
  overlay: EditsOverlay;
  /** Apply a change, recording the document it replaced. */
  edit: (label: string, update: (doc: GraphDoc) => GraphDoc, mode?: EditMode) => void;
  /** Adopt a document as a fresh start; the history goes with the old one. */
  reset: (doc: GraphDoc | null, overlay?: EditsOverlay) => void;
  undo: () => void;
  redo: () => void;
  /** What undo would take back, or null when there is nothing to take back. */
  undoLabel: string | null;
  redoLabel: string | null;
}

export function useDocHistory(): DocHistory {
  const [state, setState] = useState<State>({
    past: [],
    present: null,
    overlay: EMPTY_OVERLAY,
    future: [],
  });

  const edit = useCallback(
    (label: string, update: (doc: GraphDoc) => GraphDoc, mode: EditMode = "record") => {
      setState((s) => {
        if (!s.present) return s;
        const next = update(s.present);
        // Edits that changed nothing leave no step to take back.
        if (next === s.present) return s;
        const overlay =
          mode === "record" ? extendOverlay(s.overlay, diffDocs(s.present, next)) : s.overlay;
        return {
          past: trimPast([
            ...s.past,
            { doc: s.present, overlay: s.overlay, label, weight: entryWeight(s.present, next) },
          ]),
          present: next,
          overlay,
          future: [],
        };
      });
    },
    [],
  );

  const reset = useCallback((doc: GraphDoc | null, overlay: EditsOverlay = EMPTY_OVERLAY) => {
    setState({ past: [], present: doc, overlay, future: [] });
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const previous = s.past[s.past.length - 1];
      if (!previous || !s.present) return s;
      return {
        past: s.past.slice(0, -1),
        present: previous.doc,
        overlay: previous.overlay,
        future: [
          {
            doc: s.present,
            overlay: s.overlay,
            label: previous.label,
            // Weighed against where the history now stands, so a redo landing
            // it back in the past keeps the accounting honest.
            weight: entryWeight(s.present, previous.doc),
          },
          ...s.future,
        ],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const [next, ...rest] = s.future;
      if (!next || !s.present) return s;
      return {
        past: trimPast([
          ...s.past,
          {
            doc: s.present,
            overlay: s.overlay,
            label: next.label,
            weight: entryWeight(s.present, next.doc),
          },
        ]),
        present: next.doc,
        overlay: next.overlay,
        future: rest,
      };
    });
  }, []);

  return {
    doc: state.present,
    overlay: state.overlay,
    edit,
    reset,
    undo,
    redo,
    undoLabel: state.past[state.past.length - 1]?.label ?? null,
    redoLabel: state.future[0]?.label ?? null,
  };
}
