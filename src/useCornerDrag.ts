import { useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import type { Corner } from "./types";

/** How far the pointer must travel before a press counts as a drag, not a click. */
const DRAG_SLOP = 4;

export interface CornerDrag {
  /** Goes on the element that moves; corners are measured inside its parent. */
  ref: RefObject<HTMLDivElement | null>;
  /** True for the length of a drag, for the class that lights the overlay up. */
  dragging: boolean;
  /** Spread onto the same element. */
  handleProps: {
    style: CSSProperties | undefined;
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onClickCapture: (e: React.MouseEvent) => void;
  };
}

/**
 * Drag an overlay from one corner of the stage to another. It follows the
 * pointer, then parks in whichever corner its own centre ended up nearest.
 *
 * The overlays this drives are made of buttons, so a press has to be read as
 * either a click or a drag: past a few pixels of travel it becomes a drag, and
 * the click that press would have delivered is swallowed. A press landing on
 * something marked `data-no-drag`, like an open menu, is left alone entirely.
 */
export function useCornerDrag(
  corner: Corner,
  onCornerChange: (corner: Corner) => void,
): CornerDrag {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  /** The corner the overlay's own centre is now nearest to. */
  const nearestCorner = (): Corner => {
    const box = ref.current?.getBoundingClientRect();
    const stage = ref.current?.parentElement?.getBoundingClientRect();
    if (!box || !stage) return corner;
    const x = box.left + box.width / 2 - stage.left;
    const y = box.top + box.height / 2 - stage.top;
    const side = x < stage.width / 2 ? "left" : "right";
    return y < stage.height / 2 ? `top-${side}` : `bottom-${side}`;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("[data-no-drag]")) return;
    const origin = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;

    const onMove = (ev: globalThis.PointerEvent) => {
      const x = ev.clientX - origin.x;
      const y = ev.clientY - origin.y;
      if (!draggedRef.current && Math.hypot(x, y) < DRAG_SLOP) return;
      // Held for the length of the drag: without it the pointer picks up the
      // labels on the graph as the overlay sweeps across them.
      draggedRef.current = true;
      document.body.classList.add("dragging-overlay");
      setOffset({ x, y });
    };
    const onStop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onStop);
      window.removeEventListener("pointercancel", onStop);
      document.body.classList.remove("dragging-overlay");
      setOffset(null);
      if (!draggedRef.current) return;
      onCornerChange(nearestCorner());
      // The press focused whatever button it landed on. A drag was not aimed at
      // that button, so the focus goes with it and the overlay fades back out.
      const active = document.activeElement;
      if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur();
    };
    // Listened for on the window rather than captured on the overlay, so the
    // click that ends a press on a button still reaches that button.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onStop);
    window.addEventListener("pointercancel", onStop);
  };

  return {
    ref,
    dragging: offset !== null,
    handleProps: {
      style: offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined,
      onPointerDown,
      onClickCapture: (e) => {
        if (!draggedRef.current) return;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}
