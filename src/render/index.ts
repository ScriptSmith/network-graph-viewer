export {
  RENDERERS,
  isRendererId,
  type MarkSet,
  type RendererCallbacks,
  type RendererHandle,
  type RendererId,
  type RendererOption,
  type SharedScene,
  type ViewState,
} from "./types";
export { paintScene } from "./paint";

let webgl2: boolean | null = null;

/**
 * Whether this browser can drive the WebGL renderer at all. Asked once: the
 * answer cannot change without a different browser, and a probe context is not
 * free. cosmos.gl is WebGL2-only with no fallback of its own, so the app has
 * to know before offering it.
 */
export function webglSupported(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const canvas = document.createElement("canvas");
    webgl2 = canvas.getContext("webgl2") !== null;
  } catch {
    webgl2 = false;
  }
  return webgl2;
}
