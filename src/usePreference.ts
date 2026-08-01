import { useCallback, useEffect, useState } from "react";

/**
 * A choice about how the app looks, remembered on this device.
 *
 * The colour scheme and the motion setting are the reader's, not the graph's:
 * they say nothing about the data, so they belong here rather than in the
 * workspace, where they would travel down a share link and impose themselves on
 * whoever opened it.
 *
 * Only the page app remembers. Embedded, the surroundings answer the question
 * already, and localStorage is per origin rather than per notebook: a widget
 * that opened dark because of a tab someone had left on the same host would
 * read as a bug rather than as a memory.
 */

/** What is stored is a string a stranger could have written; callers say which. */
export interface PreferenceOptions<T extends string> {
  /** localStorage key, namespaced the way the panel sizes are. */
  key: string;
  /** Used when nothing is stored, when storage is off, and when embedded. */
  fallback: T;
  isValid: (value: unknown) => value is T;
  /** False embedded, where the setting lasts as long as the cell's output. */
  remember: boolean;
}

function read<T extends string>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const saved = localStorage.getItem(key);
    return isValid(saved) ? saved : null;
  } catch {
    // Storage turned off, or a browser that refuses it in a frame.
    return null;
  }
}

export function usePreference<T extends string>({
  key,
  fallback,
  isValid,
  remember,
}: PreferenceOptions<T>): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() =>
    remember ? (read(key, isValid) ?? fallback) : fallback,
  );

  const set = useCallback(
    (next: T) => {
      setValue(next);
      if (!remember) return;
      try {
        localStorage.setItem(key, next);
      } catch {
        // Then it lasts for this visit only, which is what it did before.
      }
    },
    [key, remember],
  );

  // Another tab of the same app is the same reader, so a choice made there is
  // this one's too. Only remote writes fire this event, so it cannot loop.
  useEffect(() => {
    if (!remember) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      // A cleared key means the default, not a value to validate.
      setValue(e.newValue === null ? fallback : isValid(e.newValue) ? e.newValue : fallback);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, fallback, isValid, remember]);

  return [value, set];
}
