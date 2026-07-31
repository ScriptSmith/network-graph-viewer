import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { withoutUrlSource } from "./lib/io";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* A graph that crashed the app came in from somewhere, and on a page that
        somewhere is the address bar. Taking the link out first is what makes
        the remount an empty graph rather than the same crash a second time. */}
    <ErrorBoundary onReset={() => window.history.replaceState(null, "", withoutUrlSource())}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
