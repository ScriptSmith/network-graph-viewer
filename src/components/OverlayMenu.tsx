import { useEffect, useRef, useState } from "react";
import type { Overlay } from "../types";

const ITEMS: { key: Overlay; name: string; hint: string }[] = [
  { key: "legend", name: "Legend", hint: "The color key in the bottom left" },
  { key: "count", name: "Node and edge count", hint: "The count in the bottom right" },
  { key: "panels", name: "Stats and inspector", hint: "The panel on the right" },
  { key: "toolbar", name: "These controls", hint: "The buttons in the top left" },
];

type Props = {
  hidden: ReadonlySet<Overlay>;
  /** False when the current styling produces nothing to put in a legend. */
  legendAvailable: boolean;
  onSetVisible: (key: Overlay, visible: boolean) => void;
  onHideAll: () => void;
  onShowAll: () => void;
};

/**
 * One control for the whole stage: a checklist of the overlays plus the
 * all-or-nothing switch the H key drives. Hiding the controls closes the menu
 * with them, which is why the faint restore button exists.
 */
export function OverlayMenu({
  hidden,
  legendAvailable,
  onSetVisible,
  onHideAll,
  onShowAll,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const anyHidden = hidden.size > 0;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      className="overlay-menu-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        // Escape closes the menu rather than reaching the stage's own handler,
        // so one press does one thing.
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={open ? "tool-btn active" : "tool-btn"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? "overlay-menu" : undefined}
        title="Choose what is drawn over the graph"
      >
        View
        {anyHidden && <span className="tool-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="overlay-menu" id="overlay-menu">
          <p className="overlay-menu-title">Show over the graph</p>
          {ITEMS.map((item) => {
            const unavailable = item.key === "legend" && !legendAvailable;
            return (
              <label
                key={item.key}
                className="check-item"
                title={unavailable ? "The current styling has no legend" : item.hint}
              >
                <input
                  type="checkbox"
                  checked={!hidden.has(item.key)}
                  disabled={unavailable}
                  onChange={(e) => onSetVisible(item.key, e.target.checked)}
                />
                <span className="check-name">{item.name}</span>
              </label>
            );
          })}
          <div className="overlay-menu-rule" />
          <button
            type="button"
            className="overlay-menu-all"
            onClick={() => (anyHidden ? onShowAll() : onHideAll())}
          >
            <span>{anyHidden ? "Show everything" : "Hide everything"}</span>
            <span className="overlay-menu-key">H</span>
          </button>
        </div>
      )}
    </div>
  );
}
