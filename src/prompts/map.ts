import { describeForPrompt } from "@/core/mapping";
import type { ContentType } from "@/core/model";
import type { SourcePost } from "@/core/source";

/**
 * Bump the version whenever the wording changes: recordings and eval results
 * are keyed by it, so an old answer is never mistaken for the new prompt's.
 */
export const MAP_PROMPT_VERSION = "map-v1";

export const MAP_SYSTEM = `You plan a content migration from a legacy CMS export into a Contentful content type. Your output is a field mapping that a developer will review and code will execute. You never write content yourself.

For every field of the target type, choose the source fields and one transform from the menu you are given. The transform must accept the kind of the source fields and fill the kind of the target field.

How to decide:
- Prefer a source that already holds the value. Use "generate" only when no source field fits, and only for short text fields (summaries, descriptions, a classification). The article body is never generated.
- When a good source is sometimes empty or too short for the field's rules, map it and add a fallback (usually "generate" from the title and content).
- Use "none" for fields with no sensible source.
- Look at the sample values, not only the names: they show what the data really looks like.
- Confidence: "high" when the samples make it obvious, "medium" when it works but has caveats, "low" when you are guessing.
- "note": one short sentence when something is worth knowing (a caveat, a data problem in the samples); otherwise empty.
- List every source field you don't use under "unmapped" with the reason.
- Put decisions an editor should make under "questions" instead of guessing.`;

export function mapUser(ct: ContentType, posts: readonly SourcePost[]): string {
  const d = describeForPrompt(posts, ct);
  return [
    `<target_content_type id="${ct.sys.id}" name="${ct.name}">\n${d.target}\n</target_content_type>`,
    `<source_fields>\n${d.sources}\n</source_fields>`,
    `<transforms>\n${d.transforms}\n</transforms>`,
    `Map every field of "${ct.sys.id}".`,
  ].join("\n\n");
}
