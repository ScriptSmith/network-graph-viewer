import { sample, table } from "./build";

/**
 * A metro network for an invented city, so nothing here is a timetable. It is
 * the sample where the styling is part of the data: a line's colour is its
 * identity, not a category to hand to a palette, so both tables carry the
 * colours and the marks take them as written. Interchanges are white, the way a
 * printed map draws them, and their dots are wider the more lines they gather.
 *
 * The segment widths are the mapmaker's, not a measurement: heavy through the
 * middle where the trains are frequent, light out on the branch ends.
 *
 * Shape-wise it is the one network here that is mostly chains, plus the ring,
 * which is the one cycle long enough to see. Where two lines share a corridor
 * the segments are written in opposite directions, so both stay visible: a pair
 * written the same way round would merge into one link and one colour.
 */

const HARBOUR = "#2f8fd6";
const ORCHARD = "#3faa54";
const FOUNDRY = "#e2762f";
const CATHEDRAL = "#9a6ad4";
const RING = "#e8b52c";

/** from, to, line, the line's colour, how wide the segment is drawn */
// prettier-ignore
const edges: [string, string, string, string, number][] = [
  ['Westgate',          'Mill Quay',         'Harbour',   HARBOUR,   2.5],
  ['Mill Quay',         'Harbour Cross',     'Harbour',   HARBOUR,   4],
  ['Harbour Cross',     'Old Custom House',  'Harbour',   HARBOUR,   6],
  ['Old Custom House',  'Cathedral Square',  'Harbour',   HARBOUR,   6],
  ['Cathedral Square',  'Lantern Fields',    'Harbour',   HARBOUR,   6],
  ['Lantern Fields',    'East Dock',         'Harbour',   HARBOUR,   6],
  ['East Dock',         'Saltmarsh',         'Harbour',   HARBOUR,   2.5],
  ['East Dock',         'Tide Point',        'Harbour',   HARBOUR,   2.5],

  ['Northfield',        'Elmwood',           'Orchard',   ORCHARD,   2.5],
  ['Elmwood',           'Orchard Hill',      'Orchard',   ORCHARD,   2.5],
  ['Orchard Hill',      'Cathedral Square',  'Orchard',   ORCHARD,   4],
  ['Cathedral Square',  'Kiln Street',       'Orchard',   ORCHARD,   6],
  ['Kiln Street',       'Southgate',         'Orchard',   ORCHARD,   6],
  ['Southgate',         'Willowmead',        'Orchard',   ORCHARD,   4],
  ['Willowmead',        'Ashcroft',          'Orchard',   ORCHARD,   2.5],

  ['Foundry Row',       'Slate Yard',        'Foundry',   FOUNDRY,   2.5],
  ['Slate Yard',        'Ironbridge',        'Foundry',   FOUNDRY,   4],
  ['Ironbridge',        'Harbour Cross',     'Foundry',   FOUNDRY,   6],
  ['Harbour Cross',     'Kiln Street',       'Foundry',   FOUNDRY,   6],
  ['Kiln Street',       'Brickworks',        'Foundry',   FOUNDRY,   4],
  ['Brickworks',        "Tanner's End",      'Foundry',   FOUNDRY,   2.5],

  ['Hilltop',           'Beacon Rise',       'Cathedral', CATHEDRAL, 2.5],
  ['Beacon Rise',       'Museum Gate',       'Cathedral', CATHEDRAL, 4],
  ['Museum Gate',       'Cathedral Square',  'Cathedral', CATHEDRAL, 6],
  ['Cathedral Square',  'Verger Street',     'Cathedral', CATHEDRAL, 6],
  ['Verger Street',     'Southgate',         'Cathedral', CATHEDRAL, 6],
  ['Southgate',         'Ferry Road',        'Cathedral', CATHEDRAL, 2.5],

  ['Harbour Cross',     'Quayside',          'Ring',      RING,      4],
  ['Quayside',          'East Dock',         'Ring',      RING,      4],
  ['East Dock',         'Marsh End',         'Ring',      RING,      4],
  ['Marsh End',         'Southgate',         'Ring',      RING,      4],
  ['Southgate',         'Parkgate',          'Ring',      RING,      4],
  ['Parkgate',          'Museum Gate',       'Ring',      RING,      4],
  ['Museum Gate',       'Ironbridge',        'Ring',      RING,      6],
  // The Foundry has this corridor too, written the other way round, so the two
  // lines render as opposing arcs instead of one hiding the other.
  ['Harbour Cross',     'Ironbridge',        'Ring',      RING,      6],
]

/**
 * station, what it is, how many lines it gathers, its colour, its radius.
 * A station wears its line's colour; an interchange belongs to more than one
 * line, so it wears none of them and is named the colour it is drawn in.
 */
// prettier-ignore
const nodes: [string, string, number, string, number][] = [
  ['Harbour Cross',     'Interchange', 3, 'white',   13],
  ['Cathedral Square',  'Interchange', 3, 'white',   13],
  ['Southgate',         'Interchange', 3, 'white',   13],
  ['Kiln Street',       'Interchange', 2, 'white',   10],
  ['East Dock',         'Interchange', 2, 'white',   10],
  ['Ironbridge',        'Interchange', 2, 'white',   10],
  ['Museum Gate',       'Interchange', 2, 'white',   10],

  ['Westgate',          'Terminus',    1, HARBOUR,   7],
  ['Mill Quay',         'Stop',        1, HARBOUR,   5],
  ['Old Custom House',  'Stop',        1, HARBOUR,   5],
  ['Lantern Fields',    'Stop',        1, HARBOUR,   5],
  ['Saltmarsh',         'Terminus',    1, HARBOUR,   7],
  ['Tide Point',        'Terminus',    1, HARBOUR,   7],

  ['Northfield',        'Terminus',    1, ORCHARD,   7],
  ['Elmwood',           'Stop',        1, ORCHARD,   5],
  ['Orchard Hill',      'Stop',        1, ORCHARD,   5],
  ['Willowmead',        'Stop',        1, ORCHARD,   5],
  ['Ashcroft',          'Terminus',    1, ORCHARD,   7],

  ['Foundry Row',       'Terminus',    1, FOUNDRY,   7],
  ['Slate Yard',        'Stop',        1, FOUNDRY,   5],
  ['Brickworks',        'Stop',        1, FOUNDRY,   5],
  ["Tanner's End",      'Terminus',    1, FOUNDRY,   7],

  ['Hilltop',           'Terminus',    1, CATHEDRAL, 7],
  ['Beacon Rise',       'Stop',        1, CATHEDRAL, 5],
  ['Verger Street',     'Stop',        1, CATHEDRAL, 5],
  ['Ferry Road',        'Terminus',    1, CATHEDRAL, 7],

  ['Quayside',          'Stop',        1, RING,      5],
  ['Marsh End',         'Stop',        1, RING,      5],
  ['Parkgate',          'Stop',        1, RING,      5],
]

export const TRANSIT = sample({
  id: "transit",
  name: "Metro lines",
  blurb:
    "Twenty-nine stations on five lines and a ring. Every segment carries its line's own colour and the width the map draws it at, so this is the sample for styling straight from a column.",
  dataset: {
    fileName: "sample-metro-lines",
    tables: [
      table("Segments", ["From", "To", "Line", "Colour", "Width"], edges),
      table("Stations", ["Station", "Kind", "Lines", "Colour", "Dot"], nodes),
    ],
  },
  nodeTable: 1,
  style: {
    nodeColor: "cell:Colour",
    nodeSize: "cell:Dot",
    edgeColor: "cell:Colour",
    edgeWidth: "cell:Width",
    arrows: false,
  },
  // The colour and dot columns are drawing instructions, not reading matter.
  nodeAttrs: ["Kind", "Lines"],
});
