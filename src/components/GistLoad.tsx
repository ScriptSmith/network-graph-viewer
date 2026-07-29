import { useState } from "react";

interface GistLoadProps {
  onLoad: (reference: string) => void;
}

/** Reading a gist needs no token, so this sits with the other ways data gets in. */
export function GistLoad({ onLoad }: GistLoadProps) {
  const [reference, setReference] = useState("");

  return (
    <div className="gist-load">
      <input
        className="control"
        type="text"
        value={reference}
        placeholder="gist URL or id"
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && reference.trim()) onLoad(reference);
        }}
        aria-label="Gist URL or id"
      />
      <button
        type="button"
        className="btn"
        disabled={reference.trim() === ""}
        onClick={() => onLoad(reference)}
      >
        Load
      </button>
    </div>
  );
}
