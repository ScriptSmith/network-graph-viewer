import { useCallback, useRef, useState, type RefObject } from "react";

/**
 * The panels that hang off a column header. They are laid out against the
 * viewport rather than the header: the table scrolls in both directions inside
 * a pane that is often only a couple of rows tall, and a panel laid out inside
 * that pane would be clipped by it.
 */

export interface HeaderAnchor {
  left: number;
  bottom: number;
}

export interface HeaderPopover {
  anchor: HeaderAnchor | null;
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  toggle: () => void;
  close: () => void;
  reanchor: () => void;
}

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
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      // The table sits at the foot of the window, so the panel opens upwards.
      bottom: window.innerHeight - rect.top + 6,
    });
  }, [width]);

  const toggle = useCallback(() => {
    if (anchor !== null) close();
    else reanchor();
  }, [anchor, close, reanchor]);

  return { anchor, open: anchor !== null, buttonRef, toggle, close, reanchor };
}
