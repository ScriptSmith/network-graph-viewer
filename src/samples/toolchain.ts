import type { CellValue } from "../types";
import { sample, table } from "./build";

/**
 * What the web toolchain rests on: every project points at what it is written
 * in, runs on, or built out of, so the layers fall out of the edges rather
 * than being drawn in. This is the sample that shows node images, and the only
 * one that reaches the network: the logos are fetched from Simple Icons, whose
 * CDN serves them cross-origin, so they render straight from the URL in the
 * node table with nothing copied into the file.
 *
 * Brand colors are the icons' own except where one is near-black, which on this
 * surface would be a hole rather than a logo; those name a lighter color in the
 * URL instead.
 */
const ICON = "https://cdn.simpleicons.org";

/** name, layer, Simple Icons slug, replacement color for a near-black brand */
// prettier-ignore
const NODES: [string, string, string, string?][] = [
  ['JavaScript',   'Foundation', 'javascript'],
  ['TypeScript',   'Foundation', 'typescript'],
  ['Rust',         'Foundation', 'rust', 'f5f5f5'],
  ['Go',           'Foundation', 'go'],
  ['Zig',          'Foundation', 'zig'],
  ['Dart',         'Foundation', 'dart'],
  ['LLVM',         'Foundation', 'llvm', 'b8bcc8'],
  ['Node.js',      'Runtime',    'nodedotjs'],
  ['Deno',         'Runtime',    'deno', '70ffaf'],
  ['Bun',          'Runtime',    'bun', 'fbf0df'],
  ['esbuild',      'Build',      'esbuild'],
  ['SWC',          'Build',      'swc'],
  ['Rolldown',     'Build',      'rolldown'],
  ['Rollup',       'Build',      'rollupdotjs'],
  ['Babel',        'Build',      'babel'],
  ['webpack',      'Build',      'webpack'],
  ['Vite',         'Build',      'vite'],
  ['React',        'Framework',  'react'],
  ['Vue',          'Framework',  'vuedotjs'],
  ['Svelte',       'Framework',  'svelte'],
  ['Angular',      'Framework',  'angular', 'e23237'],
  ['Next.js',      'Framework',  'nextdotjs', 'ffffff'],
  ['Nuxt',         'Framework',  'nuxt'],
  ['Astro',        'Framework',  'astro'],
  ['Remix',        'Framework',  'remix', 'ffffff'],
  ['Vitest',       'Quality',    'vitest'],
  ['Jest',         'Quality',    'jest'],
  ['Cypress',      'Quality',    'cypress'],
  ['Storybook',    'Quality',    'storybook'],
  ['ESLint',       'Quality',    'eslint', '7a63e0'],
  ['Prettier',     'Quality',    'prettier'],
  ['Biome',        'Quality',    'biome'],
  ['Oxc',          'Quality',    'oxc'],
  ['Tailwind CSS', 'Styling',    'tailwindcss'],
  ['PostCSS',      'Styling',    'postcss'],
  ['Sass',         'Styling',    'sass'],
  ['npm',          'Shipping',   'npm'],
  ['pnpm',         'Shipping',   'pnpm'],
  ['Yarn',         'Shipping',   'yarn'],
  ['Turborepo',    'Shipping',   'turborepo'],
  ['Electron',     'Shipping',   'electron'],
  ['Tauri',        'Shipping',   'tauri'],
]

// prettier-ignore
const edges: [string, string, string][] = [
  // Implementation languages.
  ['Deno', 'Rust', 'Written in'],
  ['Bun', 'Zig', 'Written in'],
  ['esbuild', 'Go', 'Written in'],
  ['SWC', 'Rust', 'Written in'],
  ['Rolldown', 'Rust', 'Written in'],
  ['Biome', 'Rust', 'Written in'],
  ['Oxc', 'Rust', 'Written in'],
  ['Turborepo', 'Rust', 'Written in'],
  ['Tauri', 'Rust', 'Written in'],
  ['Sass', 'Dart', 'Written in'],
  ['Sass', 'Node.js', 'Runs on'],
  ['React', 'JavaScript', 'Written in'],
  ['Svelte', 'JavaScript', 'Written in'],
  ['Vue', 'TypeScript', 'Written in'],
  ['Angular', 'TypeScript', 'Written in'],
  ['Rust', 'LLVM', 'Compiled by'],
  ['Zig', 'LLVM', 'Compiled by'],
  ['TypeScript', 'JavaScript', 'Compiles to'],
  // Everything a package script reaches for needs the same runtime.
  ['Rollup', 'Node.js', 'Runs on'],
  ['Babel', 'Node.js', 'Runs on'],
  ['webpack', 'Node.js', 'Runs on'],
  ['Jest', 'Node.js', 'Runs on'],
  ['Cypress', 'Node.js', 'Runs on'],
  ['ESLint', 'Node.js', 'Runs on'],
  ['Prettier', 'Node.js', 'Runs on'],
  ['PostCSS', 'Node.js', 'Runs on'],
  ['npm', 'Node.js', 'Runs on'],
  ['pnpm', 'Node.js', 'Runs on'],
  ['Yarn', 'Node.js', 'Runs on'],
  ['Electron', 'Node.js', 'Runs on'],
  // Composition: the part of the graph that makes it worth drawing.
  ['Vite', 'Rollup', 'Built on'],
  ['Vite', 'esbuild', 'Built on'],
  ['Vitest', 'Vite', 'Built on'],
  ['Storybook', 'Vite', 'Built on'],
  ['Storybook', 'webpack', 'Built on'],
  ['Next.js', 'React', 'Built on'],
  ['Next.js', 'SWC', 'Built on'],
  ['Nuxt', 'Vue', 'Built on'],
  ['Nuxt', 'Vite', 'Built on'],
  ['Astro', 'Vite', 'Built on'],
  ['Remix', 'React', 'Built on'],
  ['Remix', 'Vite', 'Built on'],
  ['Angular', 'esbuild', 'Built on'],
  ['Jest', 'Babel', 'Built on'],
  ['Tailwind CSS', 'PostCSS', 'Built on'],
]

const nodes: CellValue[][] = NODES.map(([name, layer, slug, color]) => [
  name,
  layer,
  color === undefined ? `${ICON}/${slug}` : `${ICON}/${slug}/${color}`,
]);

export const TOOLCHAIN = sample({
  id: "toolchain",
  name: "Web toolchain",
  blurb:
    "Forty-two projects and what each one stands on. Nodes wear their logos, loaded from a CDN by URL, so this is the sample to look at for node images.",
  dataset: {
    fileName: "sample-web-toolchain",
    tables: [
      table("Depends on", ["Project", "Depends on", "Relation"], edges),
      table("Projects", ["Project", "Layer", "Logo"], nodes),
    ],
  },
  nodeTable: 1,
  style: {
    nodeColor: "column:Layer",
    nodeImage: "column:Logo",
    edgeColor: "column:Relation",
  },
});
