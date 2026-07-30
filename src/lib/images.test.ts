import { expect, test } from "vitest";
import { imageSource } from "./images";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("data URIs pass through, other schemes do not", () => {
  const uri = `data:image/png;base64,${PNG_BASE64}`;
  expect(imageSource(uri)).toBe(uri);
  expect(imageSource("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  expect(imageSource("javascript:alert(1)")).toBeNull();
  expect(imageSource("file:///etc/passwd")).toBeNull();
  expect(imageSource("/local/avatar.png")).toBeNull();
});

test("http and https links pass through", () => {
  expect(imageSource("https://example.com/a.png")).toBe("https://example.com/a.png");
  expect(imageSource("  http://example.com/a.svg  ")).toBe("http://example.com/a.svg");
});

test("SVG markup is wrapped into a data URI", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const source = imageSource(svg);
  expect(source?.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  expect(decodeURIComponent(source?.split(",")[1] ?? "")).toBe(svg);
  // Markup that never closes is a truncated cell, not an image.
  expect(imageSource('<svg xmlns="http://www.w3.org/2000/svg">')).toBeNull();
});

test("bare base64 is typed from its leading bytes", () => {
  expect(imageSource(PNG_BASE64)).toBe(`data:image/png;base64,${PNG_BASE64}`);
  // Wrapped across lines the way a spreadsheet cell often holds it.
  const wrapped = `${PNG_BASE64.slice(0, 40)}\n${PNG_BASE64.slice(40)}`;
  expect(imageSource(wrapped)).toBe(`data:image/png;base64,${PNG_BASE64}`);
  expect(imageSource("PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==")).toContain(
    "data:image/svg+xml;base64,",
  );
  // Text that happens to be base64-shaped but names no image type.
  expect(imageSource("Engineering")).toBeNull();
  expect(imageSource("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=")).toBeNull();
});

test("empty and non-text cells hold no image", () => {
  expect(imageSource(null)).toBeNull();
  expect(imageSource("")).toBeNull();
  expect(imageSource("   ")).toBeNull();
  expect(imageSource(42)).toBeNull();
  expect(imageSource(true)).toBeNull();
});
