/**
 * The Jupyter widget.
 *
 * anywidget loads this module and calls `render` once per view. Everything
 * about mounting is `embed.ts`'s problem; this is only the wiring between the
 * app's callbacks and the traitlets on the Python side, and the one rule that
 * wiring has to keep: what comes back from the browser must never be echoed
 * out again, or the two ends will talk past each other forever.
 */
import { mount, type EmbedHandle } from "./embed";

interface Model {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  save_changes(): void;
  on(event: string, handler: () => void): void;
  off(event: string, handler: () => void): void;
}

interface RenderContext {
  model: Model;
  el: HTMLElement;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function list(value: unknown): never[] {
  // `mount` checks the members against the names it knows; this only has to
  // guarantee it is handing over an array.
  return (Array.isArray(value) ? value : []) as never[];
}

export default {
  render({ model, el }: RenderContext) {
    let handle: EmbedHandle | null = null;

    const open = () => {
      handle?.destroy();
      handle = mount(el, {
        workspace: str(model.get("workspace")),
        height: str(model.get("height")),
        panels: list(model.get("panels")),
        theme: str(model.get("theme")) as never,
        renderer: str(model.get("renderer")) as never,
        appUrl: str(model.get("app_url")),
        onSelect: (node) => {
          model.set("selected_node", node);
          model.save_changes();
        },
        onDocChange: (doc) => {
          model.set("doc", doc);
          model.save_changes();
        },
      });
    };

    // Anything that changes what is mounted rebuilds the view. `doc` is
    // deliberately absent: it is what this end reports, and reopening on it
    // would restart the app on every edit.
    const watched = ["workspace", "height", "panels", "theme", "renderer"];
    for (const key of watched) model.on(`change:${key}`, open);
    open();

    return () => {
      for (const key of watched) model.off(`change:${key}`, open);
      handle?.destroy();
    };
  },
};
