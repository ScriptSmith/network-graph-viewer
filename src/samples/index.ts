import type { SampleNetwork } from "./build";
import { SUPERVISION } from "./supervision";
import { CHARACTERS } from "./characters";
import { KITCHEN } from "./kitchen";
import { CITATIONS } from "./citations";

export type { SampleNetwork } from "./build";

/**
 * The networks the app ships with. The supervision network leads because it
 * is the one behind the empty state; the rest are each a different shape at a
 * different size: dense communities, a two-mode graph, and one large enough
 * that reading it means filtering it.
 */
export const SAMPLES: SampleNetwork[] = [SUPERVISION, CHARACTERS, KITCHEN, CITATIONS];

/** The supervision network, which also drifts behind the empty state. */
export const SAMPLE_DATASET = SUPERVISION.dataset;
