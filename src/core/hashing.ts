import { words } from "./text";

/**
 * A local stand-in embedder for when no embedding API is configured: words
 * and character trigrams hashed into a fixed-size vector ("feature hashing").
 * It's deterministic and free, and it finds spelling variants ("Ana Lucia" /
 * "Ana-Lucía"), but it knows nothing about meaning: "Eating Out" and "Food &
 * Drink" share no letters, so only a real embedding model connects them.
 * The UI says which embedder built the index.
 */
export const HASHING_ID = "hashing-512";
export const DIMENSIONS = 512;

function fnv(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function hashingEmbed(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const add = (feature: string, weight: number) => {
    const h = fnv(feature, 0x811c9dc5);
    v[h % DIMENSIONS]! += fnv(feature, 0x9e3779b9) & 1 ? weight : -weight;
  };
  for (const w of words(text)) {
    add(`w:${w}`, 1);
    const padded = `^${w}$`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.5);
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}
