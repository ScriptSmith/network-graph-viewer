/**
 * Invariants of the built standalone bundle, in the spirit of widget.test.ts:
 * the HTML export inlines this file whole, so it has to run with no bundler,
 * no server and no siblings, and the shell built around it has to give the
 * same workspace back.
 */
import { expect, test } from "vitest";
import bundle from "../public/standalone.js?raw";
import { buildStandaloneHtml, MOUNT_ID, WORKSPACE_SCRIPT_ID } from "./lib/io/html";

test("carries no reference to things only a bundler or Node would supply", () => {
  expect(bundle).not.toMatch(/\bprocess\.env\b/);
  expect(bundle).not.toMatch(/\brequire\(/);
});

test("is one file, because the exported page has nowhere to fetch a second", () => {
  expect(bundle).not.toMatch(/import\(["'`]\.\//);
  expect(bundle).not.toMatch(/new URL\([^)]*import\.meta\.url/);
});

test("looks for the shell's own ids", () => {
  expect(bundle).toContain(MOUNT_ID);
  expect(bundle).toContain(WORKSPACE_SCRIPT_ID);
});

test("a page built around the real bundle still reads its workspace back", () => {
  const workspace = JSON.stringify({ format: "network-graph-viewer", doc: { name: "t" } });
  const html = buildStandaloneHtml({ workspace, bundle, title: "t" });
  const block = new RegExp(
    `<script id="${WORKSPACE_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`,
  ).exec(html);
  expect(block).not.toBeNull();
  expect(JSON.parse((block as RegExpExecArray)[1])).toEqual(JSON.parse(workspace));
  // Three script tags, three closers: nothing inside one closed it early.
  expect(html.split("</script>").length).toBe(4);
});
