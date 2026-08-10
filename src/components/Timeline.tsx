import { useEffect, useMemo, useRef, useState } from "react";
import type { Corner, GraphDoc } from "../types";
import type { FilterStep } from "../lib/filter";
import { timeBinsOf } from "../lib/stats";
import { formatTime, type TimeColumnOption } from "../lib/timeline";
import { useCornerDrag } from "../useCornerDrag";
import { Histogram } from "./Histogram";

/**
 * The timeline strip: a histogram of the chosen time column with a brushable
 * window, and a play button that steps the window bin by bin. It is an editor
 * for one ordinary chain step, kind "timewindow"; while a brush or playback is
 * in flight the window is previewed as dimming (appearance only), and the
 * step is committed when the hand comes off, so the canvas never rebuilds
 * mid-gesture.
 */

export type TimeWindow = { min: number | null; max: number | null };
type TimewindowStep = Extract<FilterStep, { kind: "timewindow" }>;

interface TimelineProps {
  doc: GraphDoc;
  options: TimeColumnOption[];
  /** The chain's bound window step, or null when none exists yet. */
  step: TimewindowStep | null;
  /** The window being previewed, or null when nothing is in flight. */
  draft: TimeWindow | null;
  /** Which corner of the stage the strip is parked in; it is dragged between them. */
  corner: Corner;
  onCornerChange: (corner: Corner) => void;
  onPickColumn: (option: TimeColumnOption | null) => void;
  onPreview: (window: TimeWindow) => void;
  /** Fold the current preview into the chain step. */
  onCommit: () => void;
  onHide: () => void;
}

const TICK_MS = 700;

export function Timeline({
  doc,
  options,
  step,
  draft,
  corner,
  onCornerChange,
  onPickColumn,
  onPreview,
  onCommit,
  onHide,
}: TimelineProps) {
  const [playing, setPlaying] = useState(false);
  const drag = useCornerDrag(corner, onCornerChange);

  const chosen = useMemo(
    () =>
      step === null
        ? null
        : (options.find((o) => o.table === step.table && o.column === step.column) ?? null),
    [options, step],
  );

  const bins = useMemo(() => {
    if (step === null) return null;
    const rows = step.table === "edges" ? doc.edges.rows : doc.nodes.rows;
    return timeBinsOf(rows, step.column);
  }, [doc, step]);

  const window_: TimeWindow | null = draft ?? (step ? { min: step.min, max: step.max } : null);

  // The interval reads through refs so a running playback follows the latest
  // window and bins without being torn down every preview.
  const windowRef = useRef(window_);
  windowRef.current = window_;
  const binsRef = useRef(bins);
  binsRef.current = bins;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const b = binsRef.current;
      if (b === null || b.counts.length < 2) {
        setPlaying(false);
        return;
      }
      const binWidth = (b.max - b.min) / b.counts.length;
      const win = windowRef.current;
      // No window yet means starting from the first bin.
      const lo = win?.min ?? b.min;
      const hi = win?.max ?? (win?.min === null && win?.max === null ? b.min + binWidth : b.max);
      if (hi >= b.max) {
        setPlaying(false);
        onCommit();
        return;
      }
      const width = Math.max(hi - lo, binWidth);
      const nextLo = lo + binWidth;
      const nextHi = Math.min(b.max, nextLo + width);
      onPreview({
        min: nextLo <= b.min ? null : nextLo,
        max: nextHi >= b.max ? null : nextHi,
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, onPreview, onCommit]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      onCommit();
      return;
    }
    if (bins === null || bins.counts.length < 2) return;
    // Starting from nothing: open a one-bin window at the front. Starting
    // from a committed window: preview it as it stands, so the step's bounds
    // are lifted right away and the marks the playback will reveal are on
    // stage before the first tick, not after it.
    if (window_ === null || (window_.min === null && window_.max === null)) {
      const binWidth = (bins.max - bins.min) / bins.counts.length;
      onPreview({ min: null, max: bins.min + binWidth });
    } else {
      onPreview({ min: window_.min, max: window_.max });
    }
    setPlaying(true);
  };

  const readout = (() => {
    if (step === null || bins === null) return "";
    const dates = chosen?.dates ?? false;
    const lo = window_?.min ?? bins.min;
    const hi = window_?.max ?? bins.max;
    return `${formatTime(lo, dates)} – ${formatTime(hi, dates)}`;
  })();

  const windowSet = step !== null && (step.min !== null || step.max !== null || draft !== null);

  return (
    <div
      ref={drag.ref}
      className={`timeline at-${corner}${drag.dragging ? " dragging" : ""}`}
      title="Drag into another corner"
      {...drag.handleProps}
    >
      <div className="timeline-head">
        {/* Marked no-drag: a native select swallows the pointer-up that would
            end a drag, which left the strip glued to the pointer and every
            later click eaten as a drag's tail. */}
        <select
          data-no-drag=""
          className="control timeline-column"
          value={step === null ? "" : `${step.table}:${step.column}`}
          onChange={(e) => {
            const picked = options.find((o) => `${o.table}:${o.column}` === e.target.value);
            onPickColumn(picked ?? null);
          }}
          aria-label="Timeline column"
        >
          <option value="">No timeline</option>
          {options.map((o) => (
            <option key={`${o.table}:${o.column}`} value={`${o.table}:${o.column}`}>
              {o.column}
              {o.table === "nodes" ? " (nodes)" : ""}
            </option>
          ))}
        </select>
        {step !== null && (
          <>
            <button
              type="button"
              className="tool-btn timeline-play"
              onClick={togglePlay}
              disabled={bins === null || bins.counts.length < 2}
              aria-pressed={playing}
              title={playing ? "Pause and keep this window" : "Step the window through time"}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <span className="timeline-readout">{readout}</span>
            {windowSet && (
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  setPlaying(false);
                  onPreview({ min: null, max: null });
                  onCommit();
                }}
                title="Open the window to the whole range"
              >
                All
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="overlay-x"
          onClick={onHide}
          title="Hide the timeline"
          aria-label="Hide the timeline"
        >
          ×
        </button>
      </div>
      {step !== null &&
        bins !== null && (
          // The brush's own drags are the brush's; without the marker the strip
          // would ride along with every bracket pull.
          <div data-no-drag="">
            <Histogram
              bins={bins}
              min={window_?.min ?? null}
              max={window_?.max ?? null}
              label={step.column}
              windowDrag
              onChange={(min, max) => onPreview({ min, max })}
              onChangeEnd={onCommit}
            />
          </div>
        )}
    </div>
  );
}
