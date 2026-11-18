import { bodyPreserved, visibleText, type BodyCheck } from "./grounding";
import { contentType, richTextRules, type ContentType } from "./model";
import { htmlToRichText, documentText, type TransformResult } from "./richtext";
import type { SourceExport, SourcePost } from "./source";

export type BodyConversion = TransformResult & { check: BodyCheck };

/** The article body field, converted with the rules the target field declares, and the proof nothing was lost. */
export function convertBody(post: SourcePost, source: SourceExport, model: readonly ContentType[], siteOrigin: string): BodyConversion {
  const field = contentType(model, "article").fields.find((f) => f.id === "body");
  if (!field || field.type !== "RichText") throw new Error('The article type needs a RichText "body" field');
  const result = htmlToRichText(post.html, {
    siteOrigin,
    knownSlugs: new Set(source.posts.map((p) => p.slug)),
    ...richTextRules(field),
  });
  const check = bodyPreserved(visibleText(post.html), documentText(result.document), result.movedText);
  return { ...result, check };
}
