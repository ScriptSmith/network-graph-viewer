import { SAMPLES, type SampleNetwork } from "../samples";

/**
 * The shipped networks as a ruled list, so it reads as a short menu next to
 * the file controls instead of competing with them. The empty state's card
 * offers the first network as a button of its own, so the sidebar's empty
 * state skips it here; everywhere else the list is the whole menu.
 */
export function SampleList({
  onPick,
  all = false,
}: {
  onPick: (network: SampleNetwork) => void;
  all?: boolean;
}) {
  return (
    <div className="sample-links">
      {(all ? SAMPLES : SAMPLES.slice(1)).map((network) => (
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
