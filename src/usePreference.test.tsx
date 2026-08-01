/**
 * @vitest-environment jsdom
 *
 * Remembered choices: what is stored is a string anyone with the console open
 * could have written, so the guard matters more than the storing does.
 */
import { afterEach, expect, test } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isThemePreference, type ThemePreference } from "./lib/hostTheme";
import { usePreference } from "./usePreference";

const KEY = "ngv:test-theme";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  localStorage.clear();
});

/** Mount a probe over the hook and hand back a way to read and drive it. */
function mount(remember: boolean) {
  const seen: { value: ThemePreference; set: (next: ThemePreference) => void } = {
    value: "auto",
    set: () => {},
  };

  function Probe() {
    const [value, set] = usePreference<ThemePreference>({
      key: KEY,
      fallback: "dark",
      isValid: isThemePreference,
      remember,
    });
    seen.value = value;
    seen.set = set;
    return null;
  }

  const host = document.createElement("div");
  root = createRoot(host);
  act(() => root?.render(<Probe />));
  return seen;
}

test("a stored choice is what the next visit opens on", () => {
  localStorage.setItem(KEY, "light");
  expect(mount(true).value).toBe("light");
});

test("a choice is written where the next visit will find it", () => {
  const probe = mount(true);
  act(() => probe.set("light"));
  expect(probe.value).toBe("light");
  expect(localStorage.getItem(KEY)).toBe("light");
});

test("anything that is not one of the choices is the default instead", () => {
  localStorage.setItem(KEY, "__proto__");
  expect(mount(true).value).toBe("dark");
});

test("embedded, nothing is read and nothing is written", () => {
  localStorage.setItem(KEY, "light");
  const probe = mount(false);
  expect(probe.value).toBe("dark");
  act(() => probe.set("auto"));
  expect(probe.value).toBe("auto");
  expect(localStorage.getItem(KEY)).toBe("light");
});

test("a second tab of the same app is the same reader", () => {
  const probe = mount(true);
  act(() => {
    localStorage.setItem(KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "light" }));
  });
  expect(probe.value).toBe("light");
});

test("a cleared key falls back rather than carrying on", () => {
  localStorage.setItem(KEY, "light");
  const probe = mount(true);
  act(() => {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: null }));
  });
  expect(probe.value).toBe("dark");
});
