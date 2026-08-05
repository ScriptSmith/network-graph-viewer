import type { SampleNetwork } from "./build";
import { SUPERVISION } from "./supervision";
import { CHARACTERS } from "./characters";
import { KITCHEN } from "./kitchen";
import { CITATIONS } from "./citations";
import { TOOLCHAIN } from "./toolchain";
import { TRANSIT } from "./transit";
import { VOYAGES } from "./voyages";
import { SOCIAL } from "./social";

export type { SampleNetwork } from "./build";

/**
 * The networks the app ships with. The supervision network leads because it
 * is the one behind the empty state; the rest are each a different shape at a
 * different size: dense communities, a two-mode graph, a layered dependency
 * graph whose nodes wear their logos, chains and a ring that bring their own
 * colours, one with coordinates and dates for the map and the timeline, one
 * large enough that reading it means filtering it, and one large enough that
 * drawing it means leaving the SVG renderer.
 */
export const SAMPLES: SampleNetwork[] = [
  SUPERVISION,
  CHARACTERS,
  KITCHEN,
  TOOLCHAIN,
  TRANSIT,
  VOYAGES,
  CITATIONS,
  SOCIAL,
];

/** The supervision network, which also drifts behind the empty state. */
export const SAMPLE_DATASET = SUPERVISION.dataset;
