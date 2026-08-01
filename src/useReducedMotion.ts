import { useEffect, useRef, useState } from "react";

/**
 * Whether the reader has asked for less movement.
 *
 * The graph animates a great deal on purpose: layouts morph rather than jump,
 * the view eases to a new fit, a reheat lets the physics resettle. All of that
 * is the app explaining itself, and for someone with a vestibular disorder all
 * of it is the app making them unwell. The setting is the answer, and it is
 * watched rather than read once, because it can be changed while a page is open.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * What the View menu offers on top of the system setting: follow it, or
 * override it in either direction. The override exists because the system
 * preference is machine-wide and the graph is one page: someone who keeps
 * animations off in general can still choose to watch a layout settle here,
 * and someone the setting has never occurred to can ask for stillness.
 */
export const MOTION_PREFERENCES = ["auto", "full", "reduced"] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export function isMotionPreference(value: unknown): value is MotionPreference {
  return typeof value === "string" && (MOTION_PREFERENCES as readonly string[]).includes(value);
}

function match(): MediaQueryList | null {
  return typeof window === "undefined" || !window.matchMedia ? null : window.matchMedia(QUERY);
}

export function prefersReducedMotion(): boolean {
  return match()?.matches ?? false;
}

/** Subscribe to the setting; returns the teardown an effect wants anyway. */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  const query = match();
  if (!query) return () => {};
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

/**
 * The setting as a ref, for the imperative side of the canvas: d3 handlers are
 * installed once and read this when they run, so a re-render is neither needed
 * nor wanted between the reader changing their mind and the next transition.
 */
export function useReducedMotionRef(): { readonly current: boolean } {
  const ref = useRef(prefersReducedMotion());
  useEffect(() => {
    ref.current = prefersReducedMotion();
    return watchReducedMotion((reduced) => {
      ref.current = reduced;
    });
  }, []);
  return ref;
}

/** The same thing as state, for anything that has to re-render when it changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    setReduced(prefersReducedMotion());
    return watchReducedMotion(setReduced);
  }, []);
  return reduced;
}
