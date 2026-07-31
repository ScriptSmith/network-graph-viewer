/**
 * @vitest-environment jsdom
 */
import { afterEach, expect, test, vi } from "vitest";
import { detectHostTheme, isThemePreference } from "./hostTheme";

afterEach(() => {
  document.body.removeAttribute("data-jp-theme-light");
  document.body.removeAttribute("data-vscode-theme-kind");
  document.body.style.backgroundColor = "";
  vi.unstubAllGlobals();
});

/** jsdom has no matchMedia, and its absence is the last fallback anyway. */
function preferLight(light: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("light") === light,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

test("JupyterLab and Notebook 7 say so on the body", () => {
  document.body.dataset.jpThemeLight = "true";
  expect(detectHostTheme()).toBe("light");
  document.body.dataset.jpThemeLight = "false";
  expect(detectHostTheme()).toBe("dark");
});

test("VS Code says so differently, and high contrast counts as dark", () => {
  document.body.dataset.vscodeThemeKind = "vscode-light";
  expect(detectHostTheme()).toBe("light");
  document.body.dataset.vscodeThemeKind = "vscode-dark";
  expect(detectHostTheme()).toBe("dark");
  document.body.dataset.vscodeThemeKind = "vscode-high-contrast";
  expect(detectHostTheme()).toBe("dark");
});

test("a host that declares nothing is measured instead", () => {
  // This is what covers Colab and anything else unnamed: whatever the page is
  // actually painted, it has to paint it.
  preferLight(false);
  document.body.style.backgroundColor = "rgb(255, 255, 255)";
  expect(detectHostTheme()).toBe("light");
  document.body.style.backgroundColor = "rgb(17, 17, 17)";
  expect(detectHostTheme()).toBe("dark");
});

test("a transparent element is not the one painting, so the search goes up", () => {
  preferLight(false);
  document.body.style.backgroundColor = "rgb(250, 250, 250)";
  const transparent = document.createElement("div");
  document.body.append(transparent);
  expect(detectHostTheme(transparent)).toBe("light");
  transparent.remove();
});

test("with nothing to read and nothing to measure, the browser preference decides", () => {
  preferLight(true);
  expect(detectHostTheme()).toBe("light");
  preferLight(false);
  expect(detectHostTheme()).toBe("dark");
});

test("a preference arriving from a host is checked before it is believed", () => {
  expect(isThemePreference("auto")).toBe(true);
  expect(isThemePreference("light")).toBe(true);
  expect(isThemePreference("dusk")).toBe(false);
  expect(isThemePreference(null)).toBe(false);
});
