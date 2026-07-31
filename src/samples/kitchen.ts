import type { CellValue } from "../types";
import { sample, table } from "./build";

/**
 * A two-mode network: dishes on one side, ingredients on the other, an edge
 * wherever one uses the other. Nothing connects to its own kind, so every
 * path between two dishes runs through an ingredient they share. The edge
 * list is the bare minimum, two columns; all the attributes are on the nodes.
 */
// prettier-ignore
const RECIPES: [string, string, string[]][] = [
  ['Carbonara', 'Italian', ['Spaghetti', 'Egg', 'Pecorino', 'Guanciale', 'Black pepper']],
  ['Pesto', 'Italian', ['Basil', 'Pine nuts', 'Garlic', 'Parmesan', 'Olive oil']],
  ['Caprese salad', 'Italian', ['Tomato', 'Mozzarella', 'Basil', 'Olive oil', 'Salt']],
  ['Aglio e olio', 'Italian', ['Spaghetti', 'Garlic', 'Olive oil', 'Chilli', 'Parsley']],
  ['Ratatouille', 'French', ['Aubergine', 'Courgette', 'Tomato', 'Onion', 'Garlic', 'Olive oil', 'Thyme']],
  ['Vinaigrette', 'French', ['Olive oil', 'Red wine vinegar', 'Dijon mustard', 'Salt', 'Black pepper']],
  ['Guacamole', 'Mexican', ['Avocado', 'Lime', 'Coriander', 'Onion', 'Chilli', 'Salt']],
  ['Pico de gallo', 'Mexican', ['Tomato', 'Onion', 'Coriander', 'Lime', 'Chilli', 'Salt']],
  ['Hummus', 'Levantine', ['Chickpeas', 'Tahini', 'Lemon', 'Garlic', 'Olive oil', 'Cumin']],
  ['Baba ganoush', 'Levantine', ['Aubergine', 'Tahini', 'Lemon', 'Garlic', 'Olive oil', 'Cumin']],
  ['Tabbouleh', 'Levantine', ['Parsley', 'Bulgur', 'Tomato', 'Lemon', 'Olive oil', 'Mint']],
  ['Shakshuka', 'Levantine', ['Tomato', 'Egg', 'Onion', 'Garlic', 'Cumin', 'Paprika', 'Olive oil']],
  ['Tzatziki', 'Greek', ['Yoghurt', 'Cucumber', 'Garlic', 'Lemon', 'Dill', 'Olive oil']],
  ['Dal tadka', 'Indian', ['Red lentils', 'Onion', 'Garlic', 'Ginger', 'Cumin', 'Turmeric', 'Ghee', 'Chilli']],
  ['Chana masala', 'Indian', ['Chickpeas', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Cumin', 'Coriander seed', 'Chilli']],
  ['Miso soup', 'Japanese', ['Miso paste', 'Kombu', 'Tofu', 'Spring onion']],
  ['Congee', 'Chinese', ['Rice', 'Ginger', 'Spring onion', 'Soy sauce', 'Sesame oil']],
  ['Fried rice', 'Chinese', ['Rice', 'Egg', 'Spring onion', 'Soy sauce', 'Garlic', 'Sesame oil', 'Peas']],
  ['Pad thai', 'Thai', ['Rice noodles', 'Egg', 'Tamarind', 'Fish sauce', 'Peanuts', 'Bean sprouts', 'Lime', 'Garlic', 'Chilli']],
  ['Chimichurri', 'Argentine', ['Parsley', 'Garlic', 'Red wine vinegar', 'Olive oil', 'Oregano', 'Chilli']],
]

// prettier-ignore
const CATEGORY: Record<string, string> = {
  'Spaghetti': 'Grain', 'Rice': 'Grain', 'Rice noodles': 'Grain', 'Bulgur': 'Grain',
  'Egg': 'Protein', 'Tofu': 'Protein', 'Guanciale': 'Protein',
  'Chickpeas': 'Pulse', 'Red lentils': 'Pulse',
  'Pecorino': 'Dairy', 'Parmesan': 'Dairy', 'Mozzarella': 'Dairy', 'Yoghurt': 'Dairy',
  'Olive oil': 'Fat', 'Sesame oil': 'Fat', 'Ghee': 'Fat',
  'Pine nuts': 'Nut', 'Peanuts': 'Nut',
  'Tahini': 'Pantry', 'Miso paste': 'Pantry', 'Soy sauce': 'Pantry', 'Fish sauce': 'Pantry',
  'Tamarind': 'Pantry', 'Dijon mustard': 'Pantry', 'Red wine vinegar': 'Pantry', 'Kombu': 'Pantry',
  'Garlic': 'Aromatic', 'Onion': 'Aromatic', 'Ginger': 'Aromatic', 'Spring onion': 'Aromatic',
  'Chilli': 'Aromatic',
  'Tomato': 'Vegetable', 'Aubergine': 'Vegetable', 'Courgette': 'Vegetable', 'Cucumber': 'Vegetable',
  'Avocado': 'Vegetable', 'Bean sprouts': 'Vegetable', 'Peas': 'Vegetable',
  'Lemon': 'Citrus', 'Lime': 'Citrus',
  'Basil': 'Herb', 'Parsley': 'Herb', 'Coriander': 'Herb', 'Mint': 'Herb', 'Dill': 'Herb',
  'Thyme': 'Herb', 'Oregano': 'Herb',
  'Cumin': 'Spice', 'Turmeric': 'Spice', 'Paprika': 'Spice', 'Black pepper': 'Spice',
  'Coriander seed': 'Spice',
  'Salt': 'Seasoning',
}

const edges: CellValue[][] = RECIPES.flatMap(([dish, , items]) =>
  items.map((item) => [dish, item]),
);

const nodes: CellValue[][] = [
  ...RECIPES.map(([dish, cuisine]) => [dish, "Dish", cuisine, ""]),
  ...Object.entries(CATEGORY).map(([item, category]) => [item, "Ingredient", "", category]),
];

export const KITCHEN = sample({
  id: "kitchen",
  name: "Dishes and ingredients",
  blurb:
    "Twenty dishes and what goes in them. A two-mode network: dishes only ever meet through an ingredient they have in common.",
  dataset: {
    fileName: "sample-dishes-and-ingredients",
    tables: [
      table("Uses", ["Dish", "Ingredient"], edges),
      table("Items", ["Item", "Kind", "Cuisine", "Category"], nodes),
    ],
  },
  nodeTable: 1,
  style: {
    nodeColor: "column:Kind",
    arrows: false,
    // The two kinds are types, not just colors: dishes wear one look at one
    // size and answer with their cuisine, ingredients keep the size rule so
    // the shared ones still grow, and answer with their category.
    typeStyles: {
      column: "Kind",
      styles: {
        Dish: { color: "#e2762f", size: 13, attrs: ["Cuisine"] },
        Ingredient: { attrs: ["Category"] },
      },
    },
  },
});
