import { sample, table } from "./build";

/**
 * A year of container sailings between sixteen real ports, invented traffic
 * on real coordinates. It is the sample for the two views that need columns
 * the others do not carry: every port has a latitude and longitude, so the
 * Geographic layout snaps the network onto the world, and every voyage has a
 * departure date, so the timeline can play the year through. The lines and
 * regions give the type system, the schema view and the expansion preview
 * something to count, and the container loads are a heavy-tailed number for
 * the histogram brackets and the width curves.
 *
 * The dates are arranged so playing the timeline tells a story: European
 * coastal traffic through the winter, the Europe-Asia service ramping up in
 * spring, the Pacific and the southern routes joining over the summer, and
 * the loop closing back into Europe at the end of the year.
 */

/** from, to, the service it sailed on, when it left, containers aboard */
// prettier-ignore
const edges: [string, string, string, string, number][] = [
  ['Rotterdam', 'Hamburg',   'Coastal',  '2024-01-09',  900],
  ['Rotterdam', 'New York',  'Atlantic', '2024-01-16', 1800],
  ['Hamburg',   'Rotterdam', 'Coastal',  '2024-01-23',  850],
  ['Rotterdam', 'Lisbon',    'Coastal',  '2024-02-06',  700],
  ['New York',  'Rotterdam', 'Atlantic', '2024-02-13', 1750],
  ['Lisbon',    'Genoa',     'Coastal',  '2024-02-20',  650],
  ['Genoa',     'Piraeus',   'Coastal',  '2024-03-05',  720],
  ['Lisbon',    'Santos',    'Atlantic', '2024-03-12', 1400],

  ['Piraeus',   'Colombo',   'Meridian', '2024-04-02', 1600],
  ['Colombo',   'Singapore', 'Meridian', '2024-04-16', 1900],
  ['Singapore', 'Shanghai',  'Meridian', '2024-04-30', 2400],
  ['Shanghai',  'Busan',     'Meridian', '2024-05-07', 1200],
  ['Rotterdam', 'Piraeus',   'Meridian', '2024-05-14', 1500],
  ['Mumbai',    'Colombo',   'Meridian', '2024-05-21', 1100],
  ['Piraeus',   'Mumbai',    'Meridian', '2024-06-04', 1450],
  ['Busan',     'Vancouver', 'Pacific',  '2024-06-11', 2000],
  ['Shanghai',  'Vancouver', 'Pacific',  '2024-06-25', 2300],

  ['Vancouver', 'Busan',     'Pacific',  '2024-07-09', 2100],
  ['Singapore', 'Sydney',    'Austral',  '2024-07-16', 1300],
  ['Sydney',    'Singapore', 'Austral',  '2024-08-06', 1250],
  ['Colombo',   'Durban',    'Austral',  '2024-08-20',  950],
  ['Durban',    'Lagos',     'Austral',  '2024-09-03',  800],
  ['Lagos',     'Lisbon',    'Atlantic', '2024-09-17', 1000],
  ['Santos',    'Lagos',     'Atlantic', '2024-09-24',  900],

  ['Santos',    'New York',  'Atlantic', '2024-10-08', 1200],
  ['Shanghai',  'Singapore', 'Meridian', '2024-10-22', 2500],
  ['Singapore', 'Piraeus',   'Meridian', '2024-11-05', 2200],
  ['Piraeus',   'Genoa',     'Coastal',  '2024-11-19',  750],
  ['Genoa',     'Rotterdam', 'Coastal',  '2024-12-03',  820],
  ['Durban',    'Sydney',    'Austral',  '2024-12-10', 1050],
  ['Mumbai',    'Singapore', 'Meridian', '2024-12-17', 1700],
  ['Hamburg',   'New York',  'Atlantic', '2024-12-19', 1650],
]

/** port, region, hub or port, latitude, longitude */
// prettier-ignore
const nodes: [string, string, string, number, number][] = [
  ['Rotterdam', 'Europe',   'Hub',   51.92,    4.48],
  ['Hamburg',   'Europe',   'Port',  53.54,    9.98],
  ['Lisbon',    'Europe',   'Port',  38.71,   -9.14],
  ['Genoa',     'Europe',   'Port',  44.41,    8.93],
  ['Piraeus',   'Europe',   'Hub',   37.94,   23.65],
  ['Singapore', 'Asia',     'Hub',    1.29,  103.85],
  ['Shanghai',  'Asia',     'Hub',   31.23,  121.49],
  ['Busan',     'Asia',     'Port',  35.10,  129.04],
  ['Mumbai',    'Asia',     'Port',  18.94,   72.84],
  ['Colombo',   'Asia',     'Port',   6.95,   79.85],
  ['Durban',    'Africa',   'Port', -29.87,   31.03],
  ['Lagos',     'Africa',   'Port',   6.45,    3.40],
  ['Santos',    'Americas', 'Port', -23.96,  -46.33],
  ['New York',  'Americas', 'Hub',   40.67,  -74.05],
  ['Vancouver', 'Americas', 'Port',  49.29, -123.11],
  ['Sydney',    'Oceania',  'Port', -33.86,  151.20],
]

export const VOYAGES = sample({
  id: "voyages",
  name: "Port voyages",
  blurb:
    "Sixteen ports and a year of sailings. Ports carry real coordinates and voyages carry dates, so this is the sample for the Geographic layout and the timeline; regions and shipping lines give the type system something to say.",
  dataset: {
    fileName: "sample-port-voyages",
    tables: [
      table("Voyages", ["From", "To", "Line", "Departed", "Containers"], edges),
      table("Ports", ["Port", "Region", "Kind", "Lat", "Lon"], nodes),
    ],
  },
  nodeTable: 1,
  style: {
    nodeColor: "column:Region",
    edgeColor: "column:Line",
    typeStyles: { column: "Region", styles: {} },
    edgeTypeStyles: { column: "Line", styles: {} },
  },
  // The coordinates exist to be stood on.
  layout: "geo",
  layoutParams: { latColumn: "Lat", lonColumn: "Lon" },
  // The coordinates are drawing instructions, not reading matter.
  nodeAttrs: ["Region", "Kind"],
});
