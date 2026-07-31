import { useEffect, useRef, useState } from "react";
import { PANELS, type Corner, type Overlay, type Panel } from "../types";
import { THEME_PREFERENCES, type ThemePreference } from "../lib/hostTheme";
import { listen, useRootNode } from "../RootContext";

const THEME_LABELS: Record<ThemePreference, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
};

const OVERLAY_ITEMS: { key: Overlay; name: string; hint: string }[] = [
  { key: "legend", name: "Legend", hint: "The color key in the bottom left" },
  { key: "toolbar", name: "These controls", hint: "The buttons in the top left" },
];

const PANEL_ITEMS: Record<Panel, { name: string; hint: string }> = {
  sidebar: { name: "Sidebar", hint: "The steps down the left" },
  table: { name: "Data table", hint: "The pane along the bottom" },
  stats: { name: "Statistics", hint: "The panel on the right" },
};

type Props = {
  hidden: ReadonlySet<Overlay>;
  collapsed: ReadonlySet<Panel>;
  /** False when the current styling produces nothing to put in a legend. */
  legendAvailable: boolean;
  /** Where the controls are parked, so the menu opens into the stage, not out of it. */
  corner: Corner;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  onSetOverlayVisible: (key: Overlay, visible: boolean) => void;
  onSetPanelOpen: (key: Panel, open: boolean) => void;
  onHideAll: () => void;
  onShowAll: () => void;
  onHidePanels: () => void;
  onShowPanels: () => void;
};

/**
 * One control for the whole window: what the stage draws over the graph, and
 * which panels are taking room around it. The two switches at the bottom, and
 * the keys they name, clear the lot at once and put it back, which is how the
 * graph gets a screen to itself. Hiding the controls closes the menu with them,
 * which is why the faint restore button exists.
 */
export function ViewMenu({
  hidden,
  collapsed,
  legendAvailable,
  corner,
  theme,
  onThemeChange,
  onSetOverlayVisible,
  onSetPanelOpen,
  onHideAll,
  onShowAll,
  onHidePanels,
  onShowPanels,
}: Props) {
  const [open, setOpen] = useState(false);
  const root = useRootNode();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const anyHidden = hidden.size > 0 || collapsed.size > 0;
  const panelsHidden = collapsed.size === PANELS.length;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    return listen(root, "pointerdown", onPointerDown);
  }, [open, root]);

  return (
    <div
      className="view-menu-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        // Escape closes the menu rather than reaching the stage's own handler,
        // so one press does one thing.
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={open ? "tool-btn active" : "tool-btn"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? "view-menu" : undefined}
        title="Choose what is shown around the graph"
      >
        View
      </button>

      {open && (
        <div className={`view-menu from-${corner}`} id="view-menu" data-no-drag="">
          <p className="view-menu-title">Over the graph</p>
          {OVERLAY_ITEMS.map((item) => {
            const unavailable = item.key === "legend" && !legendAvailable;
            return (
              <label
                key={item.key}
                className="check-item"
                title={unavailable ? "The current styling has no legend" : item.hint}
              >
                <input
                  type="checkbox"
                  checked={!hidden.has(item.key)}
                  disabled={unavailable}
                  onChange={(e) => onSetOverlayVisible(item.key, e.target.checked)}
                />
                <span className="check-name">{item.name}</span>
              </label>
            );
          })}

          <p className="view-menu-title">Panels</p>
          {PANELS.map((key) => (
            <label key={key} className="check-item" title={PANEL_ITEMS[key].hint}>
              <input
                type="checkbox"
                checked={!collapsed.has(key)}
                onChange={(e) => onSetPanelOpen(key, e.target.checked)}
              />
              <span className="check-name">{PANEL_ITEMS[key].name}</span>
            </label>
          ))}

          <p className="view-menu-title">Colours</p>
          <div className="view-menu-choice" role="group" aria-label="Colour scheme">
            {THEME_PREFERENCES.map((option) => (
              <button
                key={option}
                type="button"
                className={option === theme ? "choice-btn active" : "choice-btn"}
                aria-pressed={option === theme}
                onClick={() => onThemeChange(option)}
                title={
                  option === "auto" ? "Follow whatever is around the graph" : `Always ${option}`
                }
              >
                {THEME_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="view-menu-rule" />
          <button
            type="button"
            className="view-menu-all"
            onClick={() => (anyHidden ? onShowAll() : onHideAll())}
          >
            <span>{anyHidden ? "Show everything" : "Hide everything"}</span>
            <span className="view-menu-key">H</span>
          </button>
          <button
            type="button"
            className="view-menu-all"
            onClick={() => (panelsHidden ? onShowPanels() : onHidePanels())}
          >
            <span>{panelsHidden ? "Show panels" : "Hide panels"}</span>
            <span className="view-menu-key">P</span>
          </button>
        </div>
      )}
    </div>
  );
}
