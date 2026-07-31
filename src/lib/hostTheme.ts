/**
 * What colour scheme the thing around us is using.
 *
 * Served as a page there is only the browser's own preference to ask. Embedded
 * there is a notebook, and notebooks disagree about how to say it: JupyterLab
 * and Notebook 7 put an attribute on the body, VS Code puts a different one,
 * and Colab says nothing at all. So the attributes are read where they exist,
 * and where they do not the host's actual background colour is measured, which
 * is the one answer every frontend gives whether it means to or not.
 */
import type { ThemeMode } from "../theme";

export type ThemePreference = "auto" | ThemeMode;

export const THEME_PREFERENCES: ThemePreference[] = ["auto", "light", "dark"];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as string[]).includes(value);
}

/** Relative luminance, for deciding whether a measured colour is a dark one. */
function luminance(color: string): number | null {
  const parts = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (!parts) return null;
  const numbers = parts[1].split(/[\s,/]+/).filter((p) => p !== "");
  if (numbers.length < 3) return null;
  const [r, g, b] = numbers.slice(0, 3).map(Number);
  // Fully transparent means the element is not the one painting the
  // background, so its colour says nothing about the theme.
  const alpha = numbers.length > 3 ? Number(numbers[3]) : 1;
  if (![r, g, b, alpha].every((n) => isFinite(n)) || alpha === 0) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The first painted background going up from an element, as a light-or-dark
 * verdict. Walks up because output areas are usually transparent and the
 * colour belongs to something further out.
 */
function measuredMode(start: Element | null): ThemeMode | null {
  for (let el = start; el !== null; el = el.parentElement) {
    const value = luminance(getComputedStyle(el).backgroundColor);
    if (value !== null) return value < 0.5 ? "dark" : "light";
  }
  return null;
}

/**
 * The host's colour scheme. `near` is any element inside the host, used for
 * the measured fallback; without one only the declared signals are read.
 */
export function detectHostTheme(near?: Element | null): ThemeMode {
  if (typeof document !== "undefined") {
    const body = document.body;

    // JupyterLab and Notebook 7 both set this, and mean it.
    const jupyter = body?.dataset.jpThemeLight;
    if (jupyter === "true") return "light";
    if (jupyter === "false") return "dark";

    // VS Code: "vscode-light" | "vscode-dark" | "vscode-high-contrast".
    const vscode = body?.dataset.vscodeThemeKind;
    if (vscode) return vscode.includes("light") ? "light" : "dark";

    // Nobody said, so look at what is actually on the screen. This is what
    // covers Colab, marimo, nbconvert output and anything else unnamed.
    const measured = measuredMode(near ?? body);
    if (measured !== null) return measured;
  }
  if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

/**
 * Call back whenever the host's answer might have changed: the attributes are
 * watched, and so is the browser preference underneath them. Returns the
 * teardown.
 */
export function watchHostTheme(onChange: () => void): () => void {
  const stops: (() => void)[] = [];

  if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.body) {
    const observer = new MutationObserver(onChange);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-jp-theme-light", "data-vscode-theme-kind", "class", "style"],
    });
    stops.push(() => observer.disconnect());
  }

  if (typeof matchMedia === "function") {
    const query = matchMedia("(prefers-color-scheme: light)");
    query.addEventListener("change", onChange);
    stops.push(() => query.removeEventListener("change", onChange));
  }

  return () => stops.forEach((stop) => stop());
}
