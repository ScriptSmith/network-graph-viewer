import { GRAPH_FONT, SURFACE } from "../theme";
import type { GraphNode } from "../types";

export interface ExportBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function contentBounds(nodes: GraphNode[], pad = 70): ExportBox {
  if (nodes.length === 0) return { x: -300, y: -300, width: 600, height: 600 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x === undefined || n.y === undefined) continue;
    minX = Math.min(minX, n.x - n.radius);
    minY = Math.min(minY, n.y - n.radius);
    maxX = Math.max(maxX, n.x + n.radius);
    maxY = Math.max(maxY, n.y + n.radius);
  }
  if (!isFinite(minX)) return { x: -300, y: -300, width: 600, height: 600 };
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/**
 * Serialize the live graph SVG as a standalone document. Marks are styled
 * with attributes rather than CSS classes, so a clone plus a background
 * rect is a faithful copy.
 */
export function buildSvgDocument(svg: SVGSVGElement, box: ExportBox): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.round(box.width)));
  clone.setAttribute("height", String(Math.round(box.height)));
  clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  clone.style.fontFamily = GRAPH_FONT;
  clone.removeAttribute("class");

  // Undo the interactive pan/zoom so the export shows the whole graph.
  const viewport = clone.querySelector("[data-viewport]");
  viewport?.removeAttribute("transform");
  // The invisible pointer-target layer has no business in a static file.
  clone.querySelector("[data-hits]")?.remove();

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", String(box.x));
  background.setAttribute("y", String(box.y));
  background.setAttribute("width", String(box.width));
  background.setAttribute("height", String(box.height));
  background.setAttribute("fill", SURFACE);
  clone.insertBefore(background, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

export function downloadSvg(svgText: string, baseName: string): void {
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  triggerDownload(blob, `${baseName}.svg`);
}

export async function downloadPng(
  svgText: string,
  box: ExportBox,
  baseName: string,
): Promise<void> {
  const scale = 2;
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not rasterize the SVG."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * scale);
    canvas.height = Math.round(box.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable in this browser.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))),
        "image/png",
      );
    });
    triggerDownload(blob, `${baseName}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
