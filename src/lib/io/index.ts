import type { Dataset, Graph, GraphDoc, GraphStyle } from "../../types";
import type { Palette } from "../../theme";
import { buildDoc } from "../doc";
import { parsePastedText } from "../parse";
import { parseGexf, writeGexf } from "./gexf";
import { parseGraphml, writeGraphml } from "./graphml";
import { looksLikeWorkspace, parseWorkspace, writeWorkspace, type WorkspaceInput } from "./ngv";
import type { ImportedGraph } from "./types";
import { dataLink, encodePayload } from "./url";

export type { ImportedGraph, Position } from "./types";
export type { Workspace, WorkspaceInput } from "./ngv";
export { NGV_EXTENSION, writeWorkspace } from "./ngv";
export { parseWorkspace, looksLikeWorkspace } from "./ngv";
export { writeGexf } from "./gexf";
export { writeGraphml } from "./graphml";
export { exportHtml } from "./html";
export * from "./gist";
export * from "./url";

/**
 * The whole session packed into a link. Compact JSON rather than the file
 * writer's indented form: an address bar has to carry every byte of this.
 */
export async function writeDataLink(input: WorkspaceInput, href?: string): Promise<string> {
  return dataLink(await encodePayload(writeWorkspace(input, { pretty: false })), href);
}

export const TEXT_EXTENSIONS = [".gexf", ".graphml", ".xml", ".json", ".csv", ".tsv", ".txt"];

export type TextFormat = "gexf" | "graphml" | "workspace" | "delimited";

/** Work out a format from the file name, falling back to sniffing the text. */
export function detectFormat(name: string, text: string): TextFormat {
  const lowered = name.toLowerCase();
  if (lowered.endsWith(".gexf")) return "gexf";
  if (lowered.endsWith(".graphml")) return "graphml";
  if (lowered.endsWith(".ngv.json")) return "workspace";

  const head = text.slice(0, 2000);
  if (/<gexf[\s>]/i.test(head)) return "gexf";
  if (/<graphml[\s>]/i.test(head)) return "graphml";
  if (looksLikeWorkspace(head)) return "workspace";
  return "delimited";
}

/**
 * Parse any text-shaped graph source into a document. Delimited text still
 * goes through SheetJS, which handles CSV, TSV and pasted cells alike.
 */
export async function parseText(
  text: string,
  name: string,
): Promise<ImportedGraph & { dataset?: Dataset }> {
  switch (detectFormat(name, text)) {
    case "gexf":
      return parseGexf(text, name);
    case "graphml":
      return parseGraphml(text, name);
    case "workspace":
      return parseWorkspace(text, name);
    case "delimited": {
      const dataset = await parsePastedText(text, name);
      return { doc: buildDoc(name, dataset.tables[0]), dataset };
    }
  }
}

export type ExportFormat = "gexf" | "graphml" | "workspace" | "csv";

export interface ExportInput extends WorkspaceInput {
  doc: GraphDoc;
  graph: Graph | null;
  style: GraphStyle;
  /** The palette in force, so an exported file carries the colours on screen. */
  palette?: Palette;
  colors: Map<string, string>;
}

export interface ExportedFile {
  name: string;
  content: string;
  mime: string;
}

/**
 * Characters that make a spreadsheet read a cell as a formula rather than as
 * text. The last two are here because Excel strips leading whitespace before
 * deciding, so a tab or a carriage return in front of an `=` hides it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Escape a value for CSV: quote it when it could otherwise break the row, and
 * defuse it when it would otherwise be run.
 *
 * Quoting is what makes a file parse. It is not what makes it safe to open: a
 * cell reading `=HYPERLINK("http://…"&A1)` survives quoting intact and executes
 * the moment the export lands in Excel, LibreOffice or Sheets. The cells here
 * can have come from a spreadsheet somebody else wrote, or from a shared link
 * anyone can write, and the whole point of this format is that it goes straight
 * back into a spreadsheet, so the leading character is neutralised with an
 * apostrophe. Every spreadsheet reads that as "the rest of this is text", and
 * drops it again on the way in.
 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // A number is left alone even when it leads with a sign, because -5 is not a
  // formula in any spreadsheet and quoting it would land the column back as
  // text. `-2+3` is a formula, and is not a number, so it still gets caught.
  const numeric = text.trim() !== "" && isFinite(Number(text));
  const safe = !numeric && FORMULA_LEAD.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n");
}

export function exportAs(format: ExportFormat, input: ExportInput): ExportedFile {
  const base = input.doc.name.replace(/\.[^.]+$/, "") || "graph";
  switch (format) {
    case "gexf":
      return {
        name: `${base}.gexf`,
        mime: "application/xml",
        content: input.graph
          ? writeGexf({
              doc: input.doc,
              graph: input.graph,
              style: input.style,
              palette: input.palette,
              colors: input.colors,
            })
          : "",
      };
    case "graphml":
      return {
        name: `${base}.graphml`,
        mime: "application/xml",
        content: writeGraphml(input.doc),
      };
    case "workspace":
      return {
        name: `${base}.ngv.json`,
        mime: "application/json",
        content: writeWorkspace(input),
      };
    case "csv":
      return {
        name: `${base}-edges.csv`,
        mime: "text/csv",
        content: toCsv(
          input.doc.edges.columns.map((c) => c.name),
          input.doc.edges.rows,
        ),
      };
  }
}

export function downloadText(file: ExportedFile): void {
  const blob = new Blob([file.content], { type: `${file.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
