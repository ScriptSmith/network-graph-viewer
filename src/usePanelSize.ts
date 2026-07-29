import { useCallback, useEffect, useState } from "react";

/**
 * A panel edge the user can drag. Both resizable panels run through this so a
 * drag, an arrow key and a double-click mean the same thing on either one, and
 * both remember their size across a reload.
 */
export interface PanelSizeOptions {
  /** localStorage key the size is remembered under. */
  storageKey: string;
  /** "x" drags a panel's right edge, "y" drags a panel's top edge. */
  axis: "x" | "y";
  /** Size a double-click returns to, and the size before anything is saved. */
  fallback: number;
  min: number;
  /** A function, so a ceiling that depends on the viewport stays honest. */
  max: () => number;
}

/** Spread onto the drag handle; it becomes the panel's separator. */
export interface PanelHandleProps {
  role: "separator";
  "aria-orientation": "horizontal" | "vertical";
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  tabIndex: number;
  title: string;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_FAST = 48;

export function usePanelSize({ storageKey, axis, fallback, min, max }: PanelSizeOptions): {
  size: number;
  handleProps: PanelHandleProps;
} {
  const clamp = useCallback(
    (px: number) => Math.round(Math.min(max(), Math.max(min, px))),
    [max, min],
  );

  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return clamp(saved > 0 ? saved : fallback);
    } catch {
      return clamp(fallback);
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(size));
    } catch {
      // Storage turned off just means the size lasts for this visit only.
    }
  }, [storageKey, size]);

  // A ceiling measured from the viewport moves when the window does, so a
  // panel sized against a tall window is pulled back in rather than left
  // hanging past the bottom of a short one.
  useEffect(() => {
    const onResize = () => setSize(clamp);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  /**
   * Drag the edge. The pointer is captured so the drag survives crossing the
   * canvas, which swallows pointer events of its own. The size is measured
   * from the edge the panel grows out of rather than accumulated from the
   * pointer's movement, so overshooting the clamp and coming back does not
   * leave the handle behind the cursor.
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      const panel = handle.parentElement?.getBoundingClientRect();
      const origin = axis === "x" ? (panel?.left ?? 0) : (panel?.bottom ?? window.innerHeight);
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add(`resizing-${axis}`);
      const onMove = (ev: PointerEvent) =>
        setSize(clamp(axis === "x" ? ev.clientX - origin : origin - ev.clientY));
      const onStop = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onStop);
        handle.removeEventListener("pointercancel", onStop);
        document.body.classList.remove(`resizing-${axis}`);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onStop);
      handle.addEventListener("pointercancel", onStop);
    },
    [axis, clamp],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const step = e.shiftKey ? KEYBOARD_STEP_FAST : KEYBOARD_STEP;
      // Up grows a panel whose top edge is the handle, the way dragging does.
      const grow = axis === "x" ? "ArrowRight" : "ArrowUp";
      const shrink = axis === "x" ? "ArrowLeft" : "ArrowDown";
      if (e.key === grow) setSize((s) => clamp(s + step));
      else if (e.key === shrink) setSize((s) => clamp(s - step));
      else return;
      e.preventDefault();
    },
    [axis, clamp],
  );

  const reset = useCallback(() => setSize(clamp(fallback)), [clamp, fallback]);

  return {
    size,
    handleProps: {
      role: "separator",
      "aria-orientation": axis === "x" ? "vertical" : "horizontal",
      "aria-valuenow": size,
      "aria-valuemin": min,
      "aria-valuemax": max(),
      tabIndex: 0,
      title: "Drag to resize, double-click to reset",
      onPointerDown,
      onKeyDown,
      onDoubleClick: reset,
    },
  };
}
