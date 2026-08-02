import { useCallback, useState } from "react";
import type { GraphDoc } from "./types";
import { diffDocs, extendOverlay, EMPTY_OVERLAY, type EditsOverlay } from "./lib/overlay";

/**
 * Undo history over the working document. Every change to the document goes
 * through `edit`, so an undo can never step over work that was recorded
 * nowhere; loading a different file calls `reset` instead, because walking
 * backwards out of one document into another is not a step anyone means.
 *
 * Whole documents are kept rather than diffs. The transforms in lib/edit.ts
 * copy only the rows they touch, so a snapshot shares almost everything with
 * the one before it and costs about what recording the change would.
 *
 * The edits overlay rides alongside: each recorded step diffs its before and
 * after documents and folds the delta in, so "update data" can replay the
 * user's work onto a fresh file. It is snapshotted with each entry, which is
 * what makes undo rewind the overlay too. Steps applied with `mode: "keep"`
 * change the document without touching the overlay; replacing the data out
 * from under the edits is exactly that.
 */

/** How many steps back the table remembers. */
const DEPTH = 50;

interface Entry {
  doc: GraphDoc;
  overlay: EditsOverlay;
  /** What was done to leave this document, so a button can name it. */
  label: string;
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
          past: [...s.past, { doc: s.present, overlay: s.overlay, label }].slice(-DEPTH),
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
        future: [{ doc: s.present, overlay: s.overlay, label: previous.label }, ...s.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const [next, ...rest] = s.future;
      if (!next || !s.present) return s;
      return {
        past: [...s.past, { doc: s.present, overlay: s.overlay, label: next.label }],
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
