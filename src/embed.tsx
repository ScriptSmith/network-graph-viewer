/**
 * Mounting the app inside something else.
 *
 * `main.tsx` puts the app on a page it owns outright. This puts it in an
 * element belonging to a host that owns a great deal else, so the whole thing
 * goes in a shadow root: the styles here stay off the host's page, the host's
 * styles stay off ours, and the listeners the app hangs on its root stop at
 * the boundary rather than swallowing every key pressed in a notebook cell.
 *
 * The graph arrives as workspace text rather than as a file or a link, and the
 * changes go back out through callbacks. Nothing here knows about notebooks.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Inlined rather than emitted beside the bundle: the shadow root needs the
// stylesheet as text, and a host that loaded one file should not have to know
// there was a second.
import css from "./index.css?inline";
import App, { type EmbedProps } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RootContext } from "./RootContext";
import { parseWorkspace, type Workspace } from "./lib/io";
import { isThemePreference, type ThemePreference } from "./lib/hostTheme";
import { isRendererId, type RendererId } from "./render";
import { PANELS, type GraphDoc, type Panel } from "./types";

export interface EmbedOptions {
  /** The workspace to open, as the `.ngv.json` text a host writes. */
  workspace?: string;
  /** How tall to make the mount. Any CSS length; the default suits a cell. */
  height?: string;
  /**
   * Which panels start open. None of them by default: a cell is not a window,
   * and the graph is what the cell is for. The stage's edge tabs put any of
   * them back, and they say which is which while they are closed.
   */
  panels?: Panel[];
  /**
   * "auto" reads the host's own colour scheme and keeps following it, which is
   * the default: a dark widget in a light notebook reads as a bug.
   */
  theme?: ThemePreference;
  /**
   * Which painter draws the marks: "svg", "canvas" or "webgl". The host knows
   * how big a graph it is handing over; the View menu can still change it.
   */
  renderer?: RendererId;
  /**
   * Where the app is served from, so a link copied out of the host points at
   * the app rather than at whatever page it was running in.
   */
  appUrl?: string;
  onSelect?: (node: string | null) => void;
  onDocChange?: (doc: GraphDoc) => void;
}

export interface EmbedHandle {
  /** Unmount and give the element back in the state it was handed over in. */
  destroy(): void;
}

const DEFAULT_HEIGHT = "700px";

/**
 * A host's workspace text, or the reason it could not be read. Thrown out of
 * `mount` this would leave the cell holding nothing at all, with the reason
 * only in the browser console, which is not where the person who called
 * `show()` is looking.
 */
function readWorkspace(text: string | undefined): { workspace?: Workspace; error?: string } {
  if (!text) return {};
  try {
    return { workspace: parseWorkspace(text, "Graph").workspace };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "That workspace could not be read." };
  }
}

export function mount(el: HTMLElement, options: EmbedOptions = {}): EmbedHandle {
  // A host may render into the same element more than once, and a second
  // `attachShadow` on one element throws.
  const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
  shadow.replaceChildren();

  const style = document.createElement("style");
  style.textContent = css;

  const container = document.createElement("div");
  // The app sizes itself to the viewport as a page and to this as an embed.
  container.style.height = options.height ?? DEFAULT_HEIGHT;
  container.style.setProperty("--app-height", "100%");

  shadow.append(style, container);

  const opened = readWorkspace(options.workspace);
  const embed: EmbedProps = {
    initial: opened.workspace,
    initialError: opened.error,
    appUrl: options.appUrl,
    // Both come across a language boundary, so neither is trusted to be one of
    // the words it is supposed to be.
    panels: (options.panels ?? []).filter((p): p is Panel => PANELS.includes(p)),
    theme: isThemePreference(options.theme) ? options.theme : "auto",
    renderer: isRendererId(options.renderer) ? options.renderer : undefined,
    onSelect: options.onSelect,
    onDocChange: options.onDocChange,
  };

  const root = createRoot(container);
  root.render(
    <StrictMode>
      <RootContext.Provider value={shadow}>
        {/* Embedded there is no address bar to clear, so what the remount has
            to be rid of is the workspace the host handed over: `embed` is ours
            and the element holding it is about to be mounted again, which is
            the whole of why dropping the field here is enough. */}
        <ErrorBoundary
          onReset={() => {
            delete embed.initial;
          }}
        >
          <App embed={embed} />
        </ErrorBoundary>
      </RootContext.Provider>
    </StrictMode>,
  );

  return {
    destroy() {
      root.unmount();
      shadow.replaceChildren();
    },
  };
}
