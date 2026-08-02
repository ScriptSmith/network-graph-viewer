import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import type { Bins } from "../lib/histogram";
import { maxOf } from "../lib/numbers";

/**
 * A mini histogram with two draggable brackets, the range-filter picture:
 * bins behind, a kept window between the brackets, everything outside veiled.
 * UI chrome rather than a graph mark, so it is plain CSS.
 *
 * The brackets are sliders to the keyboard: focusable, arrow-key adjustable,
 * Home and End for the extremes. A bracket parked on its own end of the range
 * reports null, which is "no bound at all", so dragging one all the way out
 * takes the constraint back off. The number inputs beside these remain the
 * precise path; the brackets are the fast one.
 */

interface HistogramProps {
  bins: Bins;
  min: number | null;
  max: number | null;
  /** What the values are, for the brackets' accessible names. */
  label: string;
  onChange: (min: number | null, max: number | null) => void;
  /**
   * Fired when a drag lets go, and after each keyboard step. A caller that
   * previews cheaply while the pointer is down commits here.
   */
  onChangeEnd?: () => void;
  /**
   * When set, the kept window itself can be dragged to slide both bounds
   * together, which is how a timeline is scrubbed.
   */
  windowDrag?: boolean;
}

/** Snap a value onto the step grid without collecting float dust. */
function snap(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toPrecision(12));
}

export function Histogram({
  bins,
  min,
  max,
  label,
  onChange,
  onChangeEnd,
  windowDrag = false,
}: HistogramProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = bins.max - bins.min;
  const tallest = maxOf(bins.counts, 1);

  const clampVal = (v: number) => Math.max(bins.min, Math.min(bins.max, v));
  const lo = clampVal(min ?? bins.min);
  const hi = clampVal(max ?? bins.max);
  const pct = (v: number) => (span === 0 ? 0 : ((clampVal(v) - bins.min) / span) * 100);

  const valueAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return bins.min;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return bins.min + t * span;
  };

  // A pointer reports far more moves than the step grid has quanta, and every
  // write lands on the chain, so a move that did not cross a quantum is not a
  // change at all. The last write rides a ref because a drag's move listener
  // keeps the closure it was installed with: judged against drag-start props,
  // every move after the first crossing would read as a change.
  const sent = useRef<{ min: number | null; max: number | null } | null>(null);
  const commit = (which: "min" | "max", value: number) => {
    const v = snap(clampVal(value), bins.step);
    const last = sent.current ?? { min, max };
    if (which === "min") {
      const next = v <= bins.min ? null : Math.min(v, hi);
      if (next !== last.min) {
        sent.current = { min: next, max: last.max };
        onChange(next, last.max);
      }
    } else {
      const next = v >= bins.max ? null : Math.max(v, lo);
      if (next !== last.max) {
        sent.current = { min: last.min, max: next };
        onChange(last.min, next);
      }
    }
  };

  /** Slide the whole window, holding its width, saturating at either end. */
  const commitWindow = (fromLo: number, delta: number) => {
    const width = hi - lo;
    const nextLo = Math.max(bins.min, Math.min(bins.max - width, fromLo + delta));
    const nextHi = nextLo + width;
    const boundLo = snap(nextLo, bins.step) <= bins.min ? null : snap(nextLo, bins.step);
    const boundHi = snap(nextHi, bins.step) >= bins.max ? null : snap(nextHi, bins.step);
    const last = sent.current ?? { min, max };
    if (boundLo !== last.min || boundHi !== last.max) {
      sent.current = { min: boundLo, max: boundHi };
      onChange(boundLo, boundHi);
    }
  };

  /** A gesture is over; the next one measures change from wherever props stand. */
  const finish = () => {
    sent.current = null;
    onChangeEnd?.();
  };

  // A cancelled pointer (touch scroll taking over, a pen leaving range) must
  // end the drag the way a release does, or the move listener outlives the
  // gesture and a preview-then-commit caller never gets its commit.
  const startBracketDrag = (which: "min" | "max") => (e: PointerEvent<HTMLDivElement>) => {
    if (span === 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => commit(which, valueAt(ev.clientX));
    const done = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", done);
      el.removeEventListener("pointercancel", done);
      finish();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", done);
    el.addEventListener("pointercancel", done);
    commit(which, valueAt(e.clientX));
  };

  const startWindowDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (span === 0 || !windowDrag) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const grabbedAt = valueAt(e.clientX);
    const loAtGrab = lo;
    const move = (ev: globalThis.PointerEvent) =>
      commitWindow(loAtGrab, valueAt(ev.clientX) - grabbedAt);
    const done = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", done);
      el.removeEventListener("pointercancel", done);
      finish();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", done);
    el.addEventListener("pointercancel", done);
  };

  const bracketKeys = (which: "min" | "max") => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const current = which === "min" ? lo : hi;
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - bins.step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + bins.step;
        break;
      case "Home":
        next = bins.min;
        break;
      case "End":
        next = bins.max;
        break;
      default:
        return;
    }
    e.preventDefault();
    commit(which, next);
    finish();
  };

  const windowKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    let delta: number;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        delta = -bins.step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        delta = bins.step;
        break;
      default:
        return;
    }
    e.preventDefault();
    commitWindow(lo, delta);
    finish();
  };

  return (
    <div className="histogram">
      <div className="histogram-track" ref={trackRef}>
        {bins.counts.map((count, i) => (
          <div
            key={i}
            className="histogram-bar"
            style={{ height: `${Math.max(count > 0 ? 6 : 0, (count / tallest) * 100)}%` }}
          />
        ))}
        <div className="histogram-veil" style={{ left: 0, width: `${pct(lo)}%` }} />
        <div
          className="histogram-veil"
          style={{ left: `${pct(hi)}%`, width: `${100 - pct(hi)}%` }}
        />
        {windowDrag && span > 0 && (
          <div
            className="histogram-window"
            role="slider"
            tabIndex={0}
            aria-label={`${label} window`}
            aria-valuemin={bins.min}
            aria-valuemax={bins.max}
            aria-valuenow={lo}
            aria-valuetext={`${lo} to ${hi}`}
            style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }}
            onPointerDown={startWindowDrag}
            onKeyDown={windowKeys}
          />
        )}
        {span > 0 && (
          <>
            <div
              className="histogram-bracket"
              role="slider"
              tabIndex={0}
              aria-label={`Minimum ${label}`}
              aria-valuemin={bins.min}
              aria-valuemax={bins.max}
              aria-valuenow={lo}
              style={{ left: `${pct(lo)}%` }}
              onPointerDown={startBracketDrag("min")}
              onKeyDown={bracketKeys("min")}
            />
            <div
              className="histogram-bracket"
              role="slider"
              tabIndex={0}
              aria-label={`Maximum ${label}`}
              aria-valuemin={bins.min}
              aria-valuemax={bins.max}
              aria-valuenow={hi}
              style={{ left: `${pct(hi)}%` }}
              onPointerDown={startBracketDrag("max")}
              onKeyDown={bracketKeys("max")}
            />
          </>
        )}
      </div>
    </div>
  );
}
