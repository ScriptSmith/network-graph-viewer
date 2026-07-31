import type { ExportedFile, ExportInput } from "./index";
import { writeWorkspace } from "./ngv";

/**
 * The standalone HTML export: one file carrying the viewer and the graph, so
 * the whole interactive app can be mailed around or dropped on a wiki without
 * this site's help. The shell is three parts, each findable by id: the mount
 * point, the workspace as a JSON tag, and the inlined viewer bundle, which is
 * `standalone.js`, built by `pnpm standalone` from the same embed the notebook
 * widget uses.
 */

export const MOUNT_ID = "ngv-app";
export const WORKSPACE_SCRIPT_ID = "ngv-workspace";
export const OPTIONS_SCRIPT_ID = "ngv-options";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * JSON made safe to sit inside a script tag. The workspace is user data, and
 * a cell reading `</script>` would otherwise close the tag and hand the rest
 * of the file to the parser as markup. In JSON a `<` only ever occurs inside
 * a string, where `<` reads back as the same character, so the escape
 * changes nothing about what is parsed out.
 */
const inlineJson = (json: string): string => json.replace(/</g, "\\u003c");

/**
 * The bundle is ours rather than the user's, but a minified string inside it
 * can still spell the one sequence HTML cares about. Inside a JavaScript
 * string or regex `<\/` reads back as `</`, so this too changes nothing.
 */
const inlineScript = (code: string): string => code.replace(/<\/script/gi, "<\\/script");

export interface StandaloneShell {
  /** The workspace as `.ngv.json` text. */
  workspace: string;
  /** The built viewer bundle, inlined whole. */
  bundle: string;
  title: string;
  /** Where the app lives, so share links built inside the file point home. */
  appUrl?: string;
}

export function buildStandaloneHtml({ workspace, bundle, title, appUrl }: StandaloneShell): string {
  const options = appUrl === undefined ? "{}" : JSON.stringify({ appUrl });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
      }
      /* Painted, so the app's theme detection has something to measure. */
      body {
        background: #111110;
      }
      @media (prefers-color-scheme: light) {
        body {
          background: #f2f1ec;
        }
      }
      #${MOUNT_ID} {
        height: 100%;
      }
    </style>
  </head>
  <body>
    <div id="${MOUNT_ID}"></div>
    <script id="${WORKSPACE_SCRIPT_ID}" type="application/json">${inlineJson(workspace)}</script>
    <script id="${OPTIONS_SCRIPT_ID}" type="application/json">${inlineJson(options)}</script>
    <script type="module">${inlineScript(bundle)}</script>
  </body>
</html>
`;
}

export interface ExportHtmlOptions {
  /** Where to fetch the built viewer bundle from. */
  bundleUrl: string;
  appUrl?: string;
}

export async function exportHtml(
  input: ExportInput,
  options: ExportHtmlOptions,
): Promise<ExportedFile> {
  let bundle: string | null = null;
  try {
    const response = await fetch(options.bundleUrl);
    if (response.ok) bundle = await response.text();
  } catch {
    // Falls through to the one message below; the cause is the same.
  }
  if (bundle === null) {
    throw new Error("The viewer bundle this export inlines (standalone.js) could not be loaded.");
  }
  const base = input.doc.name.replace(/\.[^.]+$/, "") || "graph";
  return {
    name: `${base}.html`,
    mime: "text/html",
    content: buildStandaloneHtml({
      workspace: writeWorkspace(input, { pretty: false }),
      bundle,
      title: input.doc.name,
      appUrl: options.appUrl,
    }),
  };
}
