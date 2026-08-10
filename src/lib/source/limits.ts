/**
 * How many edge rows the app will hold at once.
 *
 * One number, not two. It used to be the parquet reader's private cap, which
 * meant a large parquet file was silently cut down to its first 200,000 rows
 * while every other format had no cap at all: a ten-million-row CSV was read in
 * full and the page stopped responding. It is the same question in both places,
 * so it is the same constant, and past it a file opens **source-backed**
 * instead of being truncated, which is strictly better than what truncating
 * did.
 *
 * Held where the parquet cap already was rather than raised at the same time as
 * being unified: moving the ceiling is its own decision, made against a real
 * file, and the source path has to be the thing that earns it.
 *
 * This module imports nothing on purpose. The readers need the limit and the
 * source module needs the readers, so a constant that pulled either of them in
 * would close a cycle between them.
 */
export const WORKING_SET_LIMIT = 200_000;
