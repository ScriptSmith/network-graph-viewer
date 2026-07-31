import { createContext, useContext } from "react";

/**
 * Where the app's DOM actually lives.
 *
 * Served as a page that is the document, and reaching for `document` directly
 * is the same thing. Embedded it is a shadow root belonging to a host that
 * also owns a notebook, an editor and any number of other widgets, and the
 * difference matters twice: a key press outside our tree is not ours to
 * handle, and a portal hung off the page's body would land outside our styles
 * and come out unstyled.
 */
export const RootContext = createContext<Document | ShadowRoot | null>(null);

/** The node global listeners belong on. Both kinds are event targets. */
export function useRootNode(): Document | ShadowRoot {
  return useContext(RootContext) ?? document;
}

/** Where a portal escaping its stacking context can go and still be styled. */
export function usePortalTarget(): HTMLElement | ShadowRoot {
  const root = useRootNode();
  return root instanceof Document ? root.body : root;
}

/**
 * What has focus, asked of the root we live in. A shadow root answers for its
 * own tree and answers null when focus is somewhere else on the page
 * entirely, which is exactly the question worth asking before taking it.
 */
export function activeWithin(root: Document | ShadowRoot): Element | null {
  return root.activeElement;
}

/**
 * Listen on the root, and hand back the teardown an effect wants anyway. The
 * union of the two root types collapses `addEventListener` to its untyped
 * signature, so the generic is what keeps a keydown handler taking a
 * `KeyboardEvent` at the call site.
 */
export function listen<K extends keyof DocumentEventMap>(
  root: Document | ShadowRoot,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  const listener = handler as EventListener;
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}
