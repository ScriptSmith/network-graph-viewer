import { useState } from "react";

interface UrlLoadProps {
  onOpen: (url: string) => void;
}

/**
 * A remote file by URL, opened through the query engine rather than fetched
 * whole: parquet and delimited text over http(s), read by ranged requests, so
 * a file of a hundred gigabytes costs its footer and the rows asked for.
 * Whether the read works at all is the far server's call: it has to allow
 * cross-origin requests, and the error says so when it does not.
 */
export function UrlLoad({ onOpen }: UrlLoadProps) {
  const [url, setUrl] = useState("");

  return (
    <div className="gist-load">
      <input
        className="control"
        type="text"
        value={url}
        placeholder="https://…/edges.parquet"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && url.trim()) onOpen(url.trim());
        }}
        aria-label="URL of a remote CSV or parquet file"
      />
      <button
        type="button"
        className="btn"
        disabled={url.trim() === ""}
        onClick={() => onOpen(url.trim())}
      >
        Open
      </button>
    </div>
  );
}
