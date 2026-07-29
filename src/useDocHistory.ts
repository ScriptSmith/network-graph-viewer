import { useCallback, useState } from "react";
import type { GraphDoc } from "./types";

/**
 * Undo history over the working document. Every change to the document goes
 * through `edit`, so an undo can never step over work that was recorded
 * nowhere; loading a different file calls `reset` instead, because walking
 * backwards out of one document into another is not a step anyone means.
 *
 * Whole documents are kept rather than diffs. The transforms in lib/edit.ts
 * copy only the rows they touch, so a snapshot shares almost everything with
 * the one before it and costs about what recording the change would.
 */

/** How many steps back the table remembers. */
const DEPTH = 50;

interface Entry {
  doc: GraphDoc;
  /** What was done to leave this document, so a button can name it. */
  label: string;
}

interface State {
  past: Entry[];
  present: GraphDoc | null;
  future: Entry[];
}

export interface DocHistory {
  doc: GraphDoc | null;
  /** Apply a change, recording the document it replaced. */
  edit: (label: string, update: (doc: GraphDoc) => GraphDoc) => void;
  /** Adopt a document as a fresh start; the history goes with the old one. */
  reset: (doc: GraphDoc | null) => void;
  undo: () => void;
  redo: () => void;
  /** What undo would take back, or null when there is nothing to take back. */
  undoLabel: string | null;
  redoLabel: string | null;
}

export function useDocHistory(): DocHistory {
  const [state, setState] = useState<State>({ past: [], present: null, future: [] });

  const edit = useCallback((label: string, update: (doc: GraphDoc) => GraphDoc) => {
    setState((s) => {
      if (!s.present) return s;
      const next = update(s.present);
      // Edits that changed nothing leave no step to take back.
      if (next === s.present) return s;
      return {
        past: [...s.past, { doc: s.present, label }].slice(-DEPTH),
        present: next,
        future: [],
      };
    });
  }, []);

  const reset = useCallback((doc: GraphDoc | null) => {
    setState({ past: [], present: doc, future: [] });
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const previous = s.past[s.past.length - 1];
      if (!previous || !s.present) return s;
      return {
        past: s.past.slice(0, -1),
        present: previous.doc,
        future: [{ doc: s.present, label: previous.label }, ...s.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const [next, ...rest] = s.future;
      if (!next || !s.present) return s;
      return {
        past: [...s.past, { doc: s.present, label: next.label }],
        present: next.doc,
        future: rest,
      };
    });
  }, []);

  return {
    doc: state.present,
    edit,
    reset,
    undo,
    redo,
    undoLabel: state.past[state.past.length - 1]?.label ?? null,
    redoLabel: state.future[0]?.label ?? null,
  };
}
