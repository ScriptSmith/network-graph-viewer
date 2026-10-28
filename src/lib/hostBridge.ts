/**
 * Talking to the page around a kiosk.
 *
 * Messages are plain objects tagged `{ ngv: 1, type, … }`, sent with
 * `postMessage` between this window and its parent. Only the parent window is
 * listened to, and only in kiosk mode. The commands carry data the app already
 * opens from a link (a workspace or a `#data=` payload) or pick between things
 * it already shows, so a message can do no more than a link could.
 *
 * To the app:
 *   { type: "load", workspace }  a `.ngv.json` text or the object it parses to
 *   { type: "link", payload }    the payload of a `#data=` link
 *   { type: "sample", id }       one of the shipped networks
 *   { type: "select", id, center? }  a node id, or null to clear
 *   { type: "fit" } { type: "reheat" } { type: "layout", id } { type: "theme", theme }
 *   { type: "ping" }             answered with `ready`
 *
 * From the app:
 *   { type: "ready", samples }   once, and again on `ping`
 *   { type: "loaded", nodes, edges }
 *   { type: "select", id, label, degree, neighbors }  id null when cleared
 *   { type: "activity" }         a pointer is down or moving here, at most four a second, so
 *                                a host can tell the page is in use (its own listeners cannot
 *                                see into this window)
 *   { type: "error", message }
 */
import { isThemePreference, type ThemePreference } from "./hostTheme";
import type { LayoutId } from "./layouts";

export const BRIDGE_VERSION = 1;

/** Layouts that need nothing but the graph; "script" and "geo" need more. */
export const BRIDGE_LAYOUTS: readonly LayoutId[] = [
  "force",
  "forceatlas2",
  "gpu",
  "hierarchy",
  "radial",
  "circle",
  "grid",
  "circlepack",
];

/** Generous next to any real workspace; keeps a message from being a bomb. */
export const MAX_WORKSPACE_CHARS = 32 * 1024 * 1024;

export type HostCommand =
  | { type: "load"; workspace: string }
  | { type: "link"; payload: string }
  | { type: "sample"; id: string }
  | { type: "select"; id: string | null; center: boolean }
  | { type: "fit" }
  | { type: "reheat" }
  | { type: "layout"; id: LayoutId }
  | { type: "theme"; theme: ThemePreference }
  | { type: "ping" };

export type AppMessage =
  | { type: "ready"; samples: string[] }
  | { type: "loaded"; nodes: number; edges: number }
  | { type: "select"; id: string | null; label: string; degree: number; neighbors: string[] }
  | { type: "activity" }
  | { type: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A command from the host, or null for anything that is not one. */
export function parseHostCommand(data: unknown): HostCommand | null {
  if (!isRecord(data) || data.ngv !== BRIDGE_VERSION) return null;
  switch (data.type) {
    case "load": {
      const w = data.workspace;
      const text = typeof w === "string" ? w : isRecord(w) ? JSON.stringify(w) : null;
      if (text === null || text.length > MAX_WORKSPACE_CHARS) return null;
      return { type: "load", workspace: text };
    }
    case "link":
      return typeof data.payload === "string" && data.payload.length <= MAX_WORKSPACE_CHARS
        ? { type: "link", payload: data.payload }
        : null;
    case "sample":
      return typeof data.id === "string" ? { type: "sample", id: data.id } : null;
    case "select":
      if (data.id !== null && typeof data.id !== "string") return null;
      return { type: "select", id: data.id, center: data.center !== false };
    case "fit":
    case "reheat":
    case "ping":
      return { type: data.type };
    case "layout":
      return typeof data.id === "string" && (BRIDGE_LAYOUTS as readonly string[]).includes(data.id)
        ? { type: "layout", id: data.id as LayoutId }
        : null;
    case "theme":
      return isThemePreference(data.theme) ? { type: "theme", theme: data.theme } : null;
    default:
      return null;
  }
}

/**
 * Send to the parent window. The target origin is "*" because the host is
 * origin-agnostic by design; nothing sent here is more than what the host
 * could read off the graph it supplied.
 */
export function sendToHost(message: AppMessage): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ ngv: BRIDGE_VERSION, ...message }, "*");
}
