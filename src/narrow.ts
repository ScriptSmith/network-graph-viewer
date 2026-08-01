/**
 * The width at which the side panels stop flanking the graph and start coming
 * over it. It is `index.css`'s `max-width: 900px` and has to stay that same
 * number: below it a panel is a sheet, and a sheet that was opened to fetch a
 * graph is standing on the graph once it arrives.
 */
const QUERY = "(max-width: 900px)";

export function isNarrow(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}
