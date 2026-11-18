import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { words } from "./text";

/**
 * Two guardrails that don't trust the model or the transform.
 *
 * 1. `bodyPreserved`: the migrated body has the same words, in the same
 *    order, as the source body, apart from what the transform reported
 *    removing (scripts, shortcodes) or moving (captions). A word-level diff,
 *    so markup changes are free but a lost or added sentence is caught.
 *
 * 2. `ungrounded`: text the model *did* write (a summary, an SEO
 *    description) may rephrase, but every number and proper name in it has to
 *    appear in the source. That catches the classic hallucinations (a wrong
 *    price, a year, a place) without needing a second model to judge.
 */

export type BodyCheck = { ok: boolean; missing: string[]; added: string[] };

/** Longest-common-subsequence diff on word arrays; returns the words only in a and only in b, as short phrases. */
function diffWords(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const n = a.length;
  const m = b.length;
  // Bodies are a few thousand words; a full table is fine and keeps this exact.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const below = dp[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
  }
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let runA: string[] = [];
  let runB: string[] = [];
  const flush = () => {
    if (runA.length) onlyA.push(runA.join(" "));
    if (runB.length) onlyB.push(runB.join(" "));
    runA = [];
    runB = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j >= m || (i < n && (dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0))) runA.push(a[i++] as string);
    else runB.push(b[j++] as string);
  }
  flush();
  return { onlyA, onlyB };
}

/**
 * `sourceText` is the source body as plain text; `allowedGone` are texts the
 * transform reported dropping or moving. Any other difference fails.
 */
export function bodyPreserved(sourceText: string, migratedText: string, allowedGone: readonly string[] = []): BodyCheck {
  const { onlyA, onlyB } = diffWords(words(sourceText), words(migratedText));
  const gone = allowedGone.map((t) => words(t).join(" ")).filter(Boolean);
  const missing = onlyA.filter((phrase) => !gone.some((g) => g.includes(phrase)));
  return { ok: missing.length === 0 && onlyB.length === 0, missing, added: onlyB };
}

const STOP = new Set(["The", "A", "An", "This", "That", "These", "Those", "It", "Its", "We", "Our", "You", "Your", "I", "In", "On", "At", "For", "From", "With", "How", "What", "Why", "When", "Where", "Which", "Who", "And", "But", "Or", "If", "To", "Of", "By", "As", "Is", "Are", "Be", "All", "Each", "Every", "Most", "Some", "Six", "Four", "Two", "Three", "Ten", "One", "Five"]);

/** Numbers and capitalised words (names, places) a generated text uses. */
export function factTokens(text: string): string[] {
  const numbers = text.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")) ?? [];
  const names = (text.match(/\b\p{Lu}[\p{L}'’-]*/gu) ?? []).filter((w) => !STOP.has(w));
  return [...new Set([...numbers, ...names])];
}

/** Facts in `generated` that appear nowhere in `source`. Empty means grounded. */
export function ungrounded(generated: string, source: string): string[] {
  const sourceNumbers = new Set(source.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]+$/, "").replace(/,/g, "")) ?? []);
  const sourceWords = new Set(words(source));
  return factTokens(generated).filter((t) => {
    if (/^\d/.test(t)) return !sourceNumbers.has(t);
    return !words(t).every((w) => sourceWords.has(w));
  });
}

const INVISIBLE = new Set(["script", "style", "noscript", "template", "head"]);

/**
 * What a reader saw on the old page, extracted independently of the
 * transform (so the check doesn't share the transform's bugs): shortcode
 * tags removed but their inner text kept, scripts and comments skipped.
 */
export function visibleText(html: string): string {
  const dom = parseDocument(html.replace(/\[\/?[a-z_][\w-]*[^\]]*\]/gi, " "), { decodeEntities: true });
  const out: string[] = [];
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (n.type === "text") out.push((n as unknown as { data: string }).data);
      else if (n.type === "tag" && !INVISIBLE.has((n as Element).name)) {
        out.push(" ");
        walk((n as Element).children);
        out.push(" ");
      }
    }
  };
  walk(dom.children);
  return out.join("").replace(/\s+/g, " ").trim();
}
