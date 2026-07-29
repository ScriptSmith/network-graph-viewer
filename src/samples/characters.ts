import { sample, table } from "./build";

/**
 * Scene co-appearance for a fictional saga: four households, each dense
 * inside and thin between, which is the shape community detection is for.
 * Undirected in spirit, so the sample turns arrowheads off.
 */
const edgeColumns = ["Character A", "Character B", "Scenes together", "Bond"];

// prettier-ignore
const edges: [string, string, number, string][] = [
  // House Ravensmoor
  ['Lord Edmund', 'Lady Cecily', 41, 'Family'],
  ['Lord Edmund', 'Arthur Ravensmoor', 33, 'Family'],
  ['Lord Edmund', 'Beatrice Ravensmoor', 22, 'Family'],
  ['Lady Cecily', 'Arthur Ravensmoor', 27, 'Family'],
  ['Lady Cecily', 'Beatrice Ravensmoor', 31, 'Family'],
  ['Arthur Ravensmoor', 'Beatrice Ravensmoor', 24, 'Family'],
  ['Nan Skerrit', 'Beatrice Ravensmoor', 19, 'Service'],
  ['Nan Skerrit', 'Arthur Ravensmoor', 12, 'Service'],
  ['Nan Skerrit', 'Lady Cecily', 15, 'Service'],
  ['Hugh Farrow', 'Lord Edmund', 26, 'Service'],
  ['Hugh Farrow', 'Arthur Ravensmoor', 14, 'Service'],
  ['Hugh Farrow', 'Mira Vance', 17, 'Service'],
  ['Mira Vance', 'Beatrice Ravensmoor', 21, 'Service'],
  ['Mira Vance', 'Lady Cecily', 9, 'Service'],
  // House Thorne
  ['Sir Gideon Thorne', 'Lady Vesper', 29, 'Family'],
  ['Sir Gideon Thorne', 'Julian Thorne', 25, 'Family'],
  ['Sir Gideon Thorne', 'Rosalind Thorne', 18, 'Family'],
  ['Lady Vesper', 'Julian Thorne', 21, 'Family'],
  ['Lady Vesper', 'Rosalind Thorne', 23, 'Family'],
  ['Julian Thorne', 'Rosalind Thorne', 16, 'Family'],
  ['Castellan Boyd', 'Sir Gideon Thorne', 20, 'Service'],
  ['Castellan Boyd', 'Julian Thorne', 13, 'Service'],
  ['Wren Ashby', 'Rosalind Thorne', 17, 'Family'],
  ['Wren Ashby', 'Lady Vesper', 11, 'Family'],
  ['Wren Ashby', 'Castellan Boyd', 8, 'Service'],
  // The Harbour
  ['Captain Isa Marrow', 'Tobias Quill', 24, 'Ally'],
  ['Captain Isa Marrow', 'Sable', 19, 'Ally'],
  ['Tobias Quill', 'Nell Quill', 30, 'Family'],
  ['Tobias Quill', 'Dov Fisher', 15, 'Ally'],
  ['Nell Quill', 'Dov Fisher', 18, 'Ally'],
  ['Nell Quill', 'Sable', 13, 'Ally'],
  ['Dov Fisher', 'Sable', 11, 'Rival'],
  ['Doctor Ames', 'Tobias Quill', 14, 'Ally'],
  ['Doctor Ames', 'Captain Isa Marrow', 12, 'Ally'],
  ['Doctor Ames', 'Nell Quill', 9, 'Ally'],
  // The Abbey
  ['Abbess Hilde', 'Brother Anselm', 26, 'Service'],
  ['Abbess Hilde', 'Sister Perrine', 22, 'Service'],
  ['Abbess Hilde', 'Archivist Rook', 14, 'Service'],
  ['Brother Anselm', 'Sister Perrine', 19, 'Ally'],
  ['Brother Anselm', 'Novice Cato', 17, 'Service'],
  ['Sister Perrine', 'Novice Cato', 15, 'Service'],
  ['Novice Cato', 'Archivist Rook', 12, 'Ally'],
  ['Archivist Rook', 'Brother Anselm', 10, 'Ally'],
  // Between the houses: the few threads that hold the story together
  ['Arthur Ravensmoor', 'Rosalind Thorne', 28, 'Romance'],
  ['Beatrice Ravensmoor', 'Julian Thorne', 21, 'Rival'],
  ['Lord Edmund', 'Sir Gideon Thorne', 24, 'Rival'],
  ['Lady Cecily', 'Lady Vesper', 16, 'Rival'],
  ['Hugh Farrow', 'Castellan Boyd', 12, 'Rival'],
  ['Arthur Ravensmoor', 'Captain Isa Marrow', 15, 'Ally'],
  ['Mira Vance', 'Nell Quill', 13, 'Ally'],
  ['Beatrice Ravensmoor', 'Sister Perrine', 14, 'Ally'],
  ['Lord Edmund', 'Abbess Hilde', 17, 'Ally'],
  ['Brother Anselm', 'Doctor Ames', 11, 'Ally'],
  ['Archivist Rook', 'Beatrice Ravensmoor', 13, 'Ally'],
  ['Sable', 'Julian Thorne', 12, 'Ally'],
  ['Wren Ashby', 'Novice Cato', 9, 'Ally'],
  ['Sable', 'Hugh Farrow', 8, 'Rival'],
  ['Captain Isa Marrow', 'Sir Gideon Thorne', 10, 'Rival'],
]

const nodeColumns = ["Character", "House", "Billing", "Age", "Alive"];

// prettier-ignore
const nodes: [string, string, string, number, boolean][] = [
  ['Lord Edmund', 'Ravensmoor', 'Lead', 58, true],
  ['Lady Cecily', 'Ravensmoor', 'Lead', 54, true],
  ['Arthur Ravensmoor', 'Ravensmoor', 'Lead', 27, true],
  ['Beatrice Ravensmoor', 'Ravensmoor', 'Lead', 23, true],
  ['Nan Skerrit', 'Ravensmoor', 'Supporting', 71, true],
  ['Hugh Farrow', 'Ravensmoor', 'Supporting', 46, false],
  ['Mira Vance', 'Ravensmoor', 'Supporting', 25, true],
  ['Sir Gideon Thorne', 'Thorne', 'Lead', 61, false],
  ['Lady Vesper', 'Thorne', 'Lead', 49, true],
  ['Julian Thorne', 'Thorne', 'Supporting', 31, true],
  ['Rosalind Thorne', 'Thorne', 'Lead', 26, true],
  ['Castellan Boyd', 'Thorne', 'Supporting', 52, true],
  ['Wren Ashby', 'Thorne', 'Minor', 17, true],
  ['Captain Isa Marrow', 'Harbour', 'Lead', 44, true],
  ['Tobias Quill', 'Harbour', 'Supporting', 55, true],
  ['Nell Quill', 'Harbour', 'Supporting', 29, true],
  ['Dov Fisher', 'Harbour', 'Minor', 38, true],
  ['Sable', 'Harbour', 'Supporting', 33, false],
  ['Doctor Ames', 'Harbour', 'Supporting', 60, true],
  ['Abbess Hilde', 'Abbey', 'Supporting', 63, true],
  ['Brother Anselm', 'Abbey', 'Supporting', 41, true],
  ['Sister Perrine', 'Abbey', 'Supporting', 35, true],
  ['Novice Cato', 'Abbey', 'Minor', 19, true],
  ['Archivist Rook', 'Abbey', 'Minor', 47, true],
]

export const CHARACTERS = sample({
  id: "characters",
  name: "Story cast",
  blurb:
    "Characters who share scenes in a fictional saga. Four households, dense inside and thin between: the shape community detection is meant to find.",
  dataset: {
    fileName: "sample-story-cast",
    tables: [table("Scenes", edgeColumns, edges), table("Characters", nodeColumns, nodes)],
  },
  nodeTable: 1,
  style: {
    nodeColor: "column:House",
    edgeWidth: "column:Scenes together",
    arrows: false,
  },
});
