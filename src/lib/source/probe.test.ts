import { expect, test } from "vitest";
import { probeFile, WORKING_SET_LIMIT } from "./index";

const fileOf = (text: string, name = "edges.csv") => new File([text], name);

test("a small file is counted rather than estimated", async () => {
  const probe = await probeFile(fileOf("a,b\n1,2\n3,4\n"));
  expect(probe.exact).toBe(true);
  expect(probe.rows).toBe(3);
  expect(probe.overLimit).toBe(false);
});

test("row length is measured from the file rather than assumed", async () => {
  // The same byte count, in rows an order of magnitude apart. A fixed
  // bytes-per-row guess reads these two as the same file; they are not.
  const short = "1,2\n".repeat(40_000);
  const wide = ("x".repeat(96) + "\n").repeat(1650);
  expect(Math.abs(short.length - wide.length) / short.length).toBeLessThan(0.01);

  // Estimates, so near rather than exact; what matters is that they are an
  // order of magnitude apart for two files of the same byte count.
  const near = (got: number, want: number) => Math.abs(got - want) / want < 0.02;
  const shortProbe = await probeFile(fileOf(short));
  const wideProbe = await probeFile(fileOf(wide));
  expect(near(shortProbe.rows, 40_000)).toBe(true);
  expect(near(wideProbe.rows, 1650)).toBe(true);
});

test("a file past the ceiling is offered to the engine instead of truncated", async () => {
  // Big enough to need sampling, and dense enough that the sample scales up
  // past the working set.
  const rows = WORKING_SET_LIMIT + 50_000;
  const probe = await probeFile(fileOf("12345,67890\n".repeat(rows)));
  expect(probe.overLimit).toBe(true);
  // Estimated from a block, so near rather than exact.
  expect(Math.abs(probe.rows - rows) / rows).toBeLessThan(0.05);
  expect(probe.exact).toBe(false);
});

test("one enormous line is one row, not a division by zero", async () => {
  const probe = await probeFile(fileOf("a".repeat(100_000)));
  expect(probe.rows).toBe(1);
  expect(probe.overLimit).toBe(false);
  expect(await probeFile(fileOf(""))).toEqual({ rows: 0, exact: false, overLimit: false });
});
