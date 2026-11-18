import { applyMapping, checkMapping, Mapping, type MappingProblem, type Pending } from "@/core/mapping";
import { contentType, validateEntry, type EntryDraft, type Link, type Problem } from "@/core/model";
import { migratable, plainText, type SourcePost } from "@/core/source";
import { convertBody } from "@/core/convert";
import { SITE_ORIGIN, model, source } from "@/config/demo";
import { getDb } from "@/db/client";
import { logCall, saveProposal } from "@/db/repo";
import { MAP_PROMPT_VERSION, MAP_SYSTEM, mapUser } from "@/prompts/map";
import { structured } from "./llm";

/** The posts the model sees as samples: published ones, in a fixed order, so the prompt (and its recording key) is stable. */
const samplePosts = () => source.posts.filter((p) => migratable(p).ok).slice(0, 3);

export async function proposeMapping(ctId: string) {
  const ct = contentType(model, ctId);
  const result = await structured({
    purpose: "field mapping",
    promptVersion: MAP_PROMPT_VERSION,
    system: MAP_SYSTEM,
    user: mapUser(ct, samplePosts()),
    schema: Mapping,
    maxTokens: 8000,
    effort: "medium",
  });
  const db = await getDb();
  const call = await logCall(db, "field mapping", MAP_PROMPT_VERSION, result);
  const row = await saveProposal(db, result.output, call.id);
  return { row, call, problems: checkMapping(result.output, ct) };
}

/**
 * Until stage 03 links authors and topics, link fields stay pending; the
 * preview resolves only what exists in this draft (its own assets).
 */
const resolveForPreview = (l: Link): string | null => (l.sys.linkType === "Asset" ? "asset" : null);

export type Preview = { post: SourcePost; draft: EntryDraft; pending: Pending[]; usedFallback: string[]; problems: Problem[] };

export function preview(mapping: Mapping, post: SourcePost): Preview {
  const ct = contentType(model, mapping.contentType);
  const { draft, pending, usedFallback } = applyMapping(mapping, ct, post, {
    richText: (p) => convertBody(p, source, model, SITE_ORIGIN).document,
    plainText,
    resolve: resolveForPreview,
  });
  const waiting = new Set(pending.map((p) => p.target));
  const problems = validateEntry(draft, ct, resolveForPreview).filter((p) => !waiting.has(p.field));
  return { post, draft, pending, usedFallback, problems };
}

export function problemsFor(mapping: Mapping): MappingProblem[] {
  return checkMapping(mapping, contentType(model, mapping.contentType));
}
