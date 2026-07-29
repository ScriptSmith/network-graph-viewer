import { SAMPLES, type SampleNetwork } from "../samples";

/**
 * The shipped networks other than the first, which both callers offer as
 * their own button. A ruled list rather than a grid, so it reads as a short
 * menu next to the file controls instead of competing with them.
 */
export function SampleList({ onPick }: { onPick: (network: SampleNetwork) => void }) {
  return (
    <div className="sample-links">
      {SAMPLES.slice(1).map((network) => (
        <button
          key={network.id}
          type="button"
          className="sample-link"
          onClick={() => onPick(network)}
          title={network.blurb}
        >
          <span className="sample-link-name">{network.name}</span>
          <span className="sample-link-size">{network.nodeCount} nodes</span>
        </button>
      ))}
    </div>
  );
}
