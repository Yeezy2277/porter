import type { Candidate, SourceEntity } from "@/core/link";

/** Bump on any wording change: recordings and evals are keyed by it. */
export const LINK_PROMPT_VERSION = "link-v1";

export const LINK_SYSTEM = `You match authors and taxonomy terms from an old WordPress site to entries that already exist in a new Contentful space, so migrated articles link to them instead of creating duplicates.

For each source item you get the candidates a search engine retrieved. Decide:
- "link": the source is the same person, or the term means the same thing as (or clearly belongs under) one candidate. Set "entryId" to that candidate.
- "new": no candidate fits, and the item should exist in the new space. Allowed for authors and categories, never for tags.
- "skip": no candidate fits and nothing should be created (tags too specific to be a topic, meta terms).

Rules:
- Only choose an entryId from that item's own candidates. If none fits, don't force one.
- Similar names are not enough for people. Two authors are the same person only if the bios agree; an abbreviated name ("J. Smith") with a matching bio is the same person, a similar name with a different beat is not.
- A term links to a topic when an article tagged with the term clearly belongs on that topic's page. Destinations (cities, regions) can link to a country topic.
- "evidence": copy a short phrase, word for word, from the source item or the chosen candidate that supports the decision.
- "reason": one plain sentence.`;

export function linkUser(items: { source: SourceEntity; candidates: Candidate[] }[]): string {
  return items
    .map(({ source: s, candidates }) => {
      const list = candidates.length
        ? candidates.map((c) => `  - ${c.entryId}: ${c.text} (similarity ${c.similarity ?? "n/a"}, keyword rank ${c.keywordRank ?? "n/a"})`).join("\n")
        : "  (none retrieved)";
      return `<item source="${s.key}" kind="${s.kind}" used_by_posts="${s.posts}">\n${s.text}\nCandidates:\n${list}\n</item>`;
    })
    .join("\n\n");
}
