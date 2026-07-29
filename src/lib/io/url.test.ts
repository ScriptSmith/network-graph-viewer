import { expect, test } from "vitest";
import {
  dataLink,
  decodePayload,
  encodePayload,
  gistLink,
  readUrlSource,
  withoutUrlSource,
} from "./url";

const HOME = "https://example.com/network-graph-viewer/";

test("a payload survives the trip through a link", async () => {
  const text = JSON.stringify({ format: "network-graph-viewer", rows: [["a", "b"]] });
  const payload = await encodePayload(text);
  expect(await decodePayload(payload)).toBe(text);
});

test("repetitive data comes out of the packer much smaller than it went in", async () => {
  const text = "Source,Target\n" + Array.from({ length: 400 }, (_, i) => `a${i},b`).join("\n");
  const payload = await encodePayload(text);
  expect(payload.length).toBeLessThan(text.length / 2);
  expect(await decodePayload(payload)).toBe(text);
});

test("text that is not ASCII comes back the way it went in", async () => {
  const text = "Zoë,Ólafur\nसंगीत,北京\n";
  expect(await decodePayload(await encodePayload(text))).toBe(text);
});

test("a damaged link is refused rather than half-read", async () => {
  await expect(decodePayload("z!!!!not base64!!!!")).rejects.toThrow(/damaged/);
  await expect(decodePayload("zAAAAAAAA")).rejects.toThrow(/damaged/);
  await expect(decodePayload("what is this")).rejects.toThrow(/this app wrote/);
});

test("a link carries its payload in the fragment, never the query", async () => {
  const link = dataLink(await encodePayload("a,b\n1,2"), `${HOME}?gist=abc`);
  expect(new URL(link).search).toBe("");
  expect(new URL(link).hash.startsWith("#data=")).toBe(true);
});

test("the fragment is read first, then the query", async () => {
  expect(readUrlSource(`${HOME}#data=zabc`)).toEqual({ kind: "data", payload: "zabc" });
  expect(readUrlSource(`${HOME}?data=zabc`)).toEqual({ kind: "data", payload: "zabc" });
  expect(readUrlSource(`${HOME}?gist=deadbeef`)).toEqual({ kind: "gist", reference: "deadbeef" });
  expect(readUrlSource(`${HOME}#gist=deadbeef`)).toEqual({ kind: "gist", reference: "deadbeef" });
  // Data beats a gist: it needs no network and is already in hand.
  expect(readUrlSource(`${HOME}?gist=deadbeef#data=zabc`)).toEqual({
    kind: "data",
    payload: "zabc",
  });
  expect(readUrlSource(HOME)).toBeNull();
  expect(readUrlSource("not a url")).toBeNull();
});

test("a round trip through a link finds its way back to the source", async () => {
  const payload = await encodePayload("Source,Target\nAlex,Priya");
  const source = readUrlSource(dataLink(payload, HOME));
  expect(source?.kind).toBe("data");
  expect(await decodePayload(source?.kind === "data" ? source.payload : "")).toContain("Alex");
});

test("a gist link names the gist and nothing else", () => {
  expect(gistLink("deadbeef", `${HOME}#data=zabc`)).toBe(`${HOME}?gist=deadbeef`);
});

test("dropping the source leaves the rest of the address alone", () => {
  expect(withoutUrlSource(`${HOME}?gist=abc`)).toBe(HOME);
  expect(withoutUrlSource(`${HOME}#data=zabc`)).toBe(HOME);
  expect(withoutUrlSource(`${HOME}?keep=1&gist=abc`)).toBe(`${HOME}?keep=1`);
  expect(withoutUrlSource(`${HOME}#data=zabc&keep=1`)).toBe(`${HOME}#keep=1`);
});
