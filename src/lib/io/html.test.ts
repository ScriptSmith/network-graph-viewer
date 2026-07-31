/**
 * The standalone shell's one security-shaped promise: the workspace is user
 * data, and a cell spelling `</script>` must not be able to close the JSON tag
 * and hand the rest of the file to the parser as its own markup.
 */
import { expect, test } from "vitest";
import { buildStandaloneHtml, WORKSPACE_SCRIPT_ID } from "./html";

const HOSTILE = JSON.stringify({
  format: "network-graph-viewer",
  doc: { note: '</script><script>alert("owned")</script>' },
});

function workspaceBlock(html: string): string {
  const match = new RegExp(
    `<script id="${WORKSPACE_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`,
  ).exec(html);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

test("a cell spelling </script> cannot break out of the JSON tag", () => {
  const html = buildStandaloneHtml({
    workspace: HOSTILE,
    bundle: "console.log(1)",
    title: "t",
  });
  const block = workspaceBlock(html);
  expect(block).not.toContain("</script");
  // And the escape is spelling, not surgery: the same JSON reads back out.
  expect(JSON.parse(block)).toEqual(JSON.parse(HOSTILE));
});

test("a bundle string spelling </script> is escaped without changing the code", () => {
  const html = buildStandaloneHtml({
    workspace: "{}",
    bundle: 'const tag = "</script>";',
    title: "t",
  });
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  expect(module).not.toBeNull();
  const code = (module as RegExpExecArray)[1];
  expect(code).not.toContain("</script");
  // `<\/` in a JavaScript string is `</`: same program, safe spelling.
  expect(code).toContain('"<\\/script>"');
});

test("the title is escaped and the app address travels in its own block", () => {
  const html = buildStandaloneHtml({
    workspace: "{}",
    bundle: "",
    title: "<svg onload=x> & sons",
    appUrl: "https://example.test/app/",
  });
  expect(html).toContain("<title>&lt;svg onload=x&gt; &amp; sons</title>");
  expect(html).toContain('"appUrl":"https://example.test/app/"');
});
