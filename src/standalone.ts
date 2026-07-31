/**
 * The entry of the exported single-file page.
 *
 * `exportHtml` writes a shell whose JSON tags carry the workspace and a few
 * options, and inlines this bundle beside them. All this does is read those
 * tags and mount the same embed a notebook gets, shadow root and all, so the
 * exported file behaves exactly like the app that wrote it.
 */
import { mount } from "./embed";
import { MOUNT_ID, OPTIONS_SCRIPT_ID, WORKSPACE_SCRIPT_ID } from "./lib/io/html";

const el = document.getElementById(MOUNT_ID);
if (el) {
  let appUrl: string | undefined;
  try {
    const options: unknown = JSON.parse(
      document.getElementById(OPTIONS_SCRIPT_ID)?.textContent ?? "{}",
    );
    if (options !== null && typeof options === "object" && "appUrl" in options) {
      appUrl = typeof options.appUrl === "string" ? options.appUrl : undefined;
    }
  } catch {
    // A damaged options block only costs the share links their address.
  }
  mount(el, {
    workspace: document.getElementById(WORKSPACE_SCRIPT_ID)?.textContent ?? undefined,
    height: "100%",
    appUrl,
  });
}
