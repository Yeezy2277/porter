import { applyMapping, checkMapping, Mapping, type MappingProblem, type Pending } from "@/core/mapping";
import { contentType, validateEntry, type EntryDraft, type Link, type Problem } from "@/core/model";
import { migratable, plainText, type SourcePost } from "@/core/source";
import { convertBody } from "@/core/convert";
import { SITE_ORIGIN, model, source } from "@/config/demo";
import { getDb } from "@/db/client";
import { logCall, saveProposal } from "@/db/repo";
import { MAP_PROMPT_VERSION, MAP_SYSTEM, mapUser } from "@/prompts/map";
import { structured } from "./llm";
import { newEntryId, topicLinksFor, type LinkDecision } from "@/core/link";
import type { LinkRow } from "@/db/schema";
import { targets } from "./link";

/** The posts the model sees as samples: published ones, in a fixed order, so the prompt (and its recording key) is stable. */
const samplePosts = () => source.posts.filter((p) => migratable(p).ok).slice(0, 3);

/** The exact request for a content type; exported so tests can prove its recording exists and still passes the checks. */
export function mappingCall(ctId: string) {
  return {
    purpose: "field mapping",
    promptVersion: MAP_PROMPT_VERSION,
    system: MAP_SYSTEM,
    user: mapUser(contentType(model, ctId), samplePosts()),
    schema: Mapping,
    maxTokens: 8000,
    effort: "medium" as const,
  };
}

export async function proposeMapping(ctId: string) {
  const ct = contentType(model, ctId);
  const result = await structured(mappingCall(ctId));
  const db = await getDb();
  const call = await logCall(db, "field mapping", MAP_PROMPT_VERSION, result);
  const row = await saveProposal(db, result.output, call.id);
  return { row, call, problems: checkMapping(result.output, ct) };
}

const kindOf = new Map(targets.map((t) => [t.entryId, t.contentType]));

/** Resolves a link to its content type: existing entries, entries approved as "new", and this draft's assets. */
/**
 * Entries this migration creates itself: the other articles in the export
 * (posts link to each other) and the video embeds found in bodies. They don't
 * exist in the space yet, but the migration writes them before publishing,
 * so links to them are valid.
 */
const created = new Map<string, string>([
  ...source.posts.filter((p) => migratable(p).ok).map((p) => [`article-${p.slug}`.slice(0, 64), "article"] as const),
  ...source.posts.filter((p) => migratable(p).ok).flatMap((p) => convertBody(p, source, model, SITE_ORIGIN).videos.map((v) => [v.id, "videoEmbed"] as const)),
]);

export const resolver = (l: Link): string | null => {
  if (l.sys.linkType === "Asset") return "asset";
  if (l.sys.id.startsWith("author-new-")) return "author";
  if (l.sys.id.startsWith("topic-new-")) return "topic";
  return kindOf.get(l.sys.id) ?? created.get(l.sys.id) ?? null;
};

const entry = (id: string): Link => ({ sys: { type: "Link", linkType: "Entry", id } });

export type Preview = { post: SourcePost; draft: EntryDraft; pending: Pending[]; usedFallback: string[]; problems: Problem[]; droppedTopics: string[] };

/**
 * Applies the mapping to one post. Author and topic links come from the
 * approved stage-03 decisions; until those exist, link fields stay pending.
 */
export function preview(mapping: Mapping, post: SourcePost, linkRows: readonly LinkRow[] = []): Preview {
  const ct = contentType(model, mapping.contentType);
  const approved = linkRows.length > 0 && linkRows.every((r) => r.status === "approved");
  const decisions = new Map<string, LinkDecision>(
    approved ? linkRows.map((r) => [r.sourceKey, { source: r.sourceKey, decision: r.decision, entryId: r.entryId, reason: r.reason, evidence: r.evidence, decidedBy: r.decidedBy }]) : [],
  );
  const maxTopics = ct.fields.find((f) => f.id === "topics")?.validations.find((v) => v.size?.max)?.size?.max ?? 4;
  let droppedTopics: string[] = [];
  const { draft, pending, usedFallback } = applyMapping(mapping, ct, post, {
    richText: (p) => convertBody(p, source, model, SITE_ORIGIN).document,
    plainText,
    resolve: resolver,
    linkAuthor: approved
      ? (p) => {
          const d = p.author ? decisions.get(`author:${p.author.id}`) : undefined;
          if (d?.decision === "link" && d.entryId) return entry(d.entryId);
          if (d?.decision === "new" && p.author) return entry(newEntryId("author", p.author.slug));
          return null;
        }
      : undefined,
    linkTopics: approved
      ? (p) => {
          const t = topicLinksFor(p, decisions, maxTopics);
          droppedTopics = t.dropped;
          return t.ids.map(entry);
        }
      : undefined,
  });
  const waiting = new Set(pending.map((p) => p.target));
  const problems = validateEntry(draft, ct, resolver).filter((p) => !waiting.has(p.field));
  return { post, draft, pending, usedFallback, problems, droppedTopics };
}

export function problemsFor(mapping: Mapping): MappingProblem[] {
  return checkMapping(mapping, contentType(model, mapping.contentType));
}
