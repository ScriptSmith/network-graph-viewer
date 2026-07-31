import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last thing between a thrown render and a blank page.
 *
 * The derivation chain runs inside `useMemo`, which is to say during render, so
 * a document the app cannot build a graph from does not draw wrong: it throws,
 * and React unmounts the whole tree, taking with it every control that could
 * have loaded something else. That is the failure this catches.
 *
 * Recovery is a genuine remount, because React has already discarded the
 * subtree by the time we render the fallback: clearing the error mounts a fresh
 * `App` with fresh state. `onReset` is the caller's chance to take away
 * whatever it was that broke, which for a page is the link in the address bar.
 * A second failure stops offering, since a loop that keeps failing the same way
 * is worse than a message that stays put.
 */

interface Props {
  children: ReactNode;
  /** Run before remounting; should clear whatever the crash came in on. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  attempts: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempts: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Nothing is reported anywhere, so the console is the only record there is.
    console.error("Network Graph Viewer crashed while rendering.", error, info.componentStack);
  }

  private reset = (): void => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, attempts: s.attempts + 1 }));
  };

  render(): ReactNode {
    const { error, attempts } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <h2 className="crash-title">Something in that graph could not be drawn</h2>
          <p className="crash-detail">{error.message}</p>
          {attempts < 2 ? (
            <>
              <button type="button" className="btn btn-primary" onClick={this.reset}>
                Start over
              </button>
              <p className="crash-hint">
                This clears whatever was loaded. Nothing was sent anywhere, and nothing on your
                machine was changed.
              </p>
            </>
          ) : (
            <p className="crash-hint">
              Starting over did not help, so it is being left alone rather than tried again. Reload
              the page to get back to an empty graph.
            </p>
          )}
        </div>
      </div>
    );
  }
}
