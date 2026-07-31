import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HeaderAnchor, HeaderPopover } from "../useHeaderPopover";
import { listen, usePortalTarget, useRootNode } from "../RootContext";

interface HeaderPanelProps {
  popover: HeaderPopover;
  width: number;
  className: string;
  children: ReactNode;
}

/**
 * The panel itself: hung off the body, dismissed by anything outside it. It
 * exists only while it is open, so its listeners go up once when it opens
 * rather than being torn down and put back as the table moves underneath.
 */
export function HeaderPanel({ popover, width, className, children }: HeaderPanelProps) {
  if (popover.anchor === null) return null;
  return (
    <Panel popover={popover} anchor={popover.anchor} width={width} className={className}>
      {children}
    </Panel>
  );
}

function Panel({
  popover: { buttonRef, close, reanchor },
  anchor,
  width,
  className,
  children,
}: HeaderPanelProps & { anchor: HeaderAnchor }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const root = useRootNode();
  const portalTarget = usePortalTarget();

  useEffect(() => {
    const dismiss = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Node)) return close();
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const offPointer = listen(root, "pointerdown", dismiss);
    const offKey = listen(root, "keydown", onKeyDown);
    // Capturing, so scrolling the table itself counts and the panel keeps up
    // with the header it belongs to rather than being left behind by it.
    window.addEventListener("scroll", reanchor, true);
    window.addEventListener("resize", reanchor);
    return () => {
      offPointer();
      offKey();
      window.removeEventListener("scroll", reanchor, true);
      window.removeEventListener("resize", reanchor);
    };
  }, [buttonRef, close, reanchor, root]);

  // Hung off the root rather than the header cell: the sticky header carries a
  // stacking context of its own, and inside it no z-index can lift the panel
  // over the buttons that ride the edges of the pane.
  return createPortal(
    <div
      ref={panelRef}
      className={className}
      style={{ left: anchor.left, bottom: anchor.bottom, width }}
    >
      {children}
    </div>,
    portalTarget,
  );
}
