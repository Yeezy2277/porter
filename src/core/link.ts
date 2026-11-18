import { z } from "zod";
import type { SourceExport, SourcePost } from "./source";
import { migratable } from "./source";
import { words } from "./text";

/**
 * Linking: which existing Contentful entry is this WordPress author or term?
 *
 * Retrieval narrows thousands of entries to a handful of candidates (vector
 * similarity and keyword match, fused by rank). Plain rules settle the
 * obvious cases. Claude decides only the rest, choosing among the retrieved
 * candidates and quoting its evidence, and code checks that it did.
 */

export type TargetKind = "author" | "topic";
export type TargetEntity = { entryId: string; contentType: TargetKind; name: string; slug: string; text: string };
export type SourceEntity = { key: string; contentType: TargetKind; kind: "author" | "category" | "tag"; name: string; slug: string; text: string; posts: number };

const TargetEntries = z.object({
  authors: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), bio: z.string() })),
  topics: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), description: z.string() })),
});

export function targetEntities(input: unknown): TargetEntity[] {
  const t = TargetEntries.parse(input);
  return [
    ...t.authors.map((a) => ({ entryId: a.id, contentType: "author" as const, name: a.name, slug: a.slug, text: `Author: ${a.name}. ${a.bio}` })),
    ...t.topics.map((x) => ({ entryId: x.id, contentType: "topic" as const, name: x.name, slug: x.slug, text: `Topic: ${x.name}. ${x.description}` })),
  ];
}

/** Authors and terms used by posts that will migrate; unused ones aren't worth a decision. */
export function sourceEntities(src: SourceExport): SourceEntity[] {
  const posts = src.posts.filter((p) => migratable(p).ok);
  const count = (pred: (p: SourcePost) => boolean) => posts.filter(pred).length;
  const authors = src.authors
    .map((a) => ({ a, n: count((p) => p.author?.id === a.id) }))
    .filter((x) => x.n > 0)
    .map(({ a, n }) => ({ key: `author:${a.id}`, contentType: "author" as const, kind: "author" as const, name: a.name, slug: a.slug, text: `Author: ${a.name}${a.bio ? `. ${a.bio}` : ""}`, posts: n }));
  const terms = src.terms
    .map((t) => ({ t, n: count((p) => p.terms.some((x) => x.kind === t.kind && x.id === t.id)) }))
    .filter((x) => x.n > 0)
    .map(({ t, n }) => ({ key: `${t.kind}:${t.id}`, contentType: "topic" as const, kind: t.kind, name: t.name, slug: t.slug, text: `${t.kind === "category" ? "Category" : "Tag"}: ${t.name}`, posts: n }));
  return [...authors, ...terms];
}

/** Text a search engine sees: lowercase words without accents or punctuation ("Ana-Lucía" → "ana lucia"). */
export const searchText = (s: string) => words(s).join(" ");

/**
 * Reciprocal Rank Fusion: each list votes 1/(k + rank) for its items. Ranks,
 * not raw scores, so a cosine similarity and a text-search rank can be
 * combined without calibrating one against the other. k = 60 is the usual
 * constant from the original paper; it keeps one list's top hit from
 * drowning out agreement between lists.
 */
export function rrf(lists: readonly (readonly string[])[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return scores;
}

export type Candidate = {
  entryId: string;
  name: string;
  text: string;
  /** Cosine similarity, or null when the vector search didn't return it. */
  similarity: number | null;
  vectorRank: number | null;
  keywordRank: number | null;
  fused: number;
};

export function fuse(vector: { entryId: string; similarity: number }[], keyword: { entryId: string }[], entities: ReadonlyMap<string, TargetEntity>, limit = 5): Candidate[] {
  const v = vector.map((x) => x.entryId);
  const kw = keyword.map((x) => x.entryId);
  return [...rrf([v, kw])]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .flatMap(([entryId, fused]) => {
      const e = entities.get(entryId);
      if (!e) return [];
      const vi = v.indexOf(entryId);
      const ki = kw.indexOf(entryId);
      return [{ entryId, name: e.name, text: e.text, similarity: vi >= 0 ? (vector[vi]?.similarity ?? null) : null, vectorRank: vi >= 0 ? vi + 1 : null, keywordRank: ki >= 0 ? ki + 1 : null, fused }];
    });
}

export type Decision = "link" | "new" | "skip";
export type DecidedBy = "rule" | "claude" | "person";
export type LinkDecision = { source: string; decision: Decision; entryId: string | null; reason: string; evidence: string; decidedBy: DecidedBy };

/** WordPress's default category: assigned when nobody chose one, so it means nothing. */
const DEFAULT_TERMS = new Set(["uncategorized", "uncategorised"]);

/** Settles what needs no judgement: the same name (ignoring accents and punctuation), or WordPress's default category. */
export function ruleDecision(src: SourceEntity, candidates: readonly Candidate[]): LinkDecision | null {
  if (src.kind === "category" && DEFAULT_TERMS.has(src.slug)) {
    return { source: src.key, decision: "skip", entryId: null, reason: "WordPress's default category carries no meaning.", evidence: src.name, decidedBy: "rule" };
  }
  const same = candidates.find((c) => searchText(c.name) === searchText(src.name));
  if (same) return { source: src.key, decision: "link", entryId: same.entryId, reason: "Same name once accents and punctuation are ignored.", evidence: same.name, decidedBy: "rule" };
  return null;
}

/** What Claude may answer for a batch: entry ids limited to the retrieved candidates. */
export function decisionSchema(keys: readonly string[], candidateIds: readonly string[]) {
  return z.object({
    decisions: z.array(
      z.object({
        source: z.enum(keys as [string, ...string[]]),
        decision: z.enum(["link", "new", "skip"]),
        entryId: candidateIds.length ? z.enum(candidateIds as [string, ...string[]]).nullable() : z.null(),
        reason: z.string(),
        evidence: z.string(),
      }),
    ),
  });
}

/**
 * Code's check of one model decision. The schema already limits ids to the
 * batch's candidates; this checks the id belongs to *this* source's
 * candidates, the decision is allowed for its kind, and the quoted evidence
 * really appears in the source or the chosen candidate.
 */
export function checkDecision(src: SourceEntity, candidates: readonly Candidate[], d: Omit<LinkDecision, "decidedBy">): string[] {
  const out: string[] = [];
  if (d.decision === "link" && !d.entryId) out.push("A link needs an entry");
  if (d.decision !== "link" && d.entryId) out.push(`"${d.decision}" can't name an entry`);
  const chosen = d.entryId ? candidates.find((c) => c.entryId === d.entryId) : null;
  if (d.entryId && !chosen) out.push(`${d.entryId} wasn't among the candidates retrieved for ${src.name}`);
  if (d.decision === "new" && src.kind === "tag") out.push("Tags don't become new topics; skip or link");
  const quote = searchText(d.evidence);
  const sources = [src.text, ...(chosen ? [chosen.text] : [])].map(searchText);
  if (!quote) out.push("No evidence quoted");
  else if (!sources.some((s) => ` ${s} `.includes(` ${quote} `))) out.push(`The evidence "${d.evidence}" isn't in the source or the chosen entry`);
  return out;
}

/** Topic links for one post: categories before tags, no duplicates, at most `max` (the field's size limit). */
export function topicLinksFor(post: SourcePost, decisions: ReadonlyMap<string, LinkDecision>, max: number): { ids: string[]; dropped: string[] } {
  const ordered = [...post.terms.filter((t) => t.kind === "category"), ...post.terms.filter((t) => t.kind === "tag")];
  const ids: string[] = [];
  const dropped: string[] = [];
  for (const t of ordered) {
    const d = decisions.get(`${t.kind}:${t.id}`);
    const id = d?.decision === "link" ? d.entryId : d?.decision === "new" ? newEntryId("topic", t.slug) : null;
    if (!id || ids.includes(id)) continue;
    if (ids.length < max) ids.push(id);
    else dropped.push(t.name);
  }
  return { ids, dropped };
}

/** The id a "new" decision will create in stage 04, stable so re-runs don't duplicate it. */
export const newEntryId = (type: TargetKind, slug: string) => `${type}-new-${slug}`.slice(0, 64);
