/**
 * A page that is somebody's display rather than a tool, in four steps from
 * least to most of the app. Whatever the step, nothing can be imported: the
 * graph is chosen by the link (`#data=…`, `?gist=…`) or sent by the page around
 * it, through the bridge in `hostBridge.ts`. The switch is read from the
 * address once, at load, and cannot be changed from inside the page.
 *
 *   display  the graph alone, not touchable; the host drives it
 *   touch    plus pan, zoom, drag and tap to select, with a small node card
 *   panels   plus the read-only panels: find, fit, layout and view buttons,
 *            legend, timeline and the info panel (paths, neighbourhoods)
 *   app      the whole app, with the data table, filters, style, metrics and
 *            export, and keyboard shortcuts, but no way to bring data in
 *
 * `?kiosk=1`, `true`, `on` and `view` mean `touch`; an empty value does too.
 * Any other word means `display`, the least that can be shown.
 */
import { isThemePreference, type ThemePreference } from "./hostTheme";
import { isRendererId, type RendererId } from "../render";

export const KIOSK_LEVELS = ["display", "touch", "panels", "app"] as const;
export type KioskLevel = (typeof KIOSK_LEVELS)[number];

export interface KioskOptions {
  level: KioskLevel;
  theme?: ThemePreference;
  renderer?: RendererId;
  /** Whether the page draws its own card for the selected node. */
  card: boolean;
  /**
   * Whether a double tap on a node narrows the graph to its neighbours. That is undone from
   * the info panel, so below the `panels` step it is off unless the address asks (`expand=1`).
   */
  expand: boolean;
}

function param(url: URL, key: string): string | null {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  return hash.get(key) ?? url.searchParams.get(key);
}

const OFF = new Set(["0", "false", "no", "off"]);
const TOUCH = new Set(["", "1", "true", "yes", "on", "view"]);

/** Whether a kiosk at `level` has everything the step `needed` gives. */
export function kioskAllows(kiosk: KioskOptions | null, needed: KioskLevel): boolean {
  return kiosk === null || KIOSK_LEVELS.indexOf(kiosk.level) >= KIOSK_LEVELS.indexOf(needed);
}

function levelOf(value: string): KioskLevel {
  const word = value.toLowerCase();
  if ((KIOSK_LEVELS as readonly string[]).includes(word)) return word as KioskLevel;
  return TOUCH.has(word) ? "touch" : "display";
}

export function readKiosk(href: string = window.location.href): KioskOptions | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const on = param(url, "kiosk");
  if (on === null || OFF.has(on.toLowerCase())) return null;
  const theme = param(url, "theme");
  const renderer = param(url, "renderer");
  const card = param(url, "card");
  const level = levelOf(on);
  const expand = param(url, "expand");
  return {
    level,
    expand:
      expand === null
        ? kioskAllows({ level, card: true, expand: true }, "panels")
        : !OFF.has(expand.toLowerCase()),
    theme: theme !== null && isThemePreference(theme) ? theme : undefined,
    renderer: renderer !== null && isRendererId(renderer) ? renderer : undefined,
    card: card === null || !OFF.has(card.toLowerCase()),
  };
}
