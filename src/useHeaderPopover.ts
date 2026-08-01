import { useCallback, useRef, useState, type RefObject } from "react";

/**
 * The panels that hang off the data pane: a column header's, and the menus
 * along its bar. They are laid out against the viewport rather than against the
 * button they belong to, because the pane cannot hold them. It scrolls in both
 * directions and is often only a couple of rows tall, so a panel laid out
 * inside it would be clipped by it; and its bar wraps, so a menu hung off the
 * side of its own button would open past the side of a narrow window.
 */

export interface HeaderAnchor {
  left: number;
  /** Set when the panel opens upwards, which is the usual direction. */
  bottom?: number;
  /** Set instead when it opens downwards, with nothing above to open into. */
  top?: number;
  /** What is left of the window on that side, so a long panel scrolls. */
  maxHeight: number;
}

export interface HeaderPopover {
  anchor: HeaderAnchor | null;
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  toggle: () => void;
  close: () => void;
  reanchor: () => void;
}

/** How close to the edge of the window a panel may sit, and to its button. */
const MARGIN = 8;
const GAP = 6;

export function useHeaderPopover(width: number): HeaderPopover {
  const [anchor, setAnchor] = useState<HeaderAnchor | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Stable, so the panel's listeners are not torn down and put back on every
  // frame the virtualizer re-renders the table under it.
  const close = useCallback(() => setAnchor(null), []);

  /**
   * Follow the header rather than close with it. Acting on the panel re-filters
   * or re-sorts the table underneath, which can scroll it, and a panel that
   * shut every time the thing it was working on moved would be unusable.
   */
  const reanchor = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return setAnchor(null);
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
    // Whichever side has more room. Wide, the table sits at the foot of the
    // window and the answer is always upwards; narrow, it is laid over the
    // whole window and its header is at the top, where opening upwards would
    // put the panel off the top of the screen instead of inside the pane.
    const above = rect.top - GAP - MARGIN;
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    setAnchor(
      above >= below
        ? { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: above }
        : { left, top: rect.bottom + GAP, maxHeight: below },
    );
  }, [width]);

  const toggle = useCallback(() => {
    if (anchor !== null) close();
    else reanchor();
  }, [anchor, close, reanchor]);

  return { anchor, open: anchor !== null, buttonRef, toggle, close, reanchor };
}
