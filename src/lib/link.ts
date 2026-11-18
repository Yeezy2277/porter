import entriesJson from "../../samples/contentful-entries.json";
import { checkDecision, decisionSchema, fuse, ruleDecision, sourceEntities, targetEntities, type Candidate, type LinkDecision, type SourceEntity, type TargetKind } from "@/core/link";
import { source } from "@/config/demo";
import { getDb, type Db } from "@/db/client";
import { logCall } from "@/db/repo";
import { indexState, keywordSearch, rebuildIndex, saveLinkProposals, vectorSearch } from "@/db/search";
import { LINK_PROMPT_VERSION, LINK_SYSTEM, linkUser } from "@/prompts/link";
import { embed, embedder } from "./embed";
import { structured } from "./llm";

export const targets = targetEntities(entriesJson);
const byId = new Map(targets.map((t) => [t.entryId, t]));

/** Embeds every existing entry and replaces the index. */
export async function buildIndex(db?: Db): Promise<{ rows: number; embedder: string; tokens: number }> {
  const e = embedder();
  const { vectors, tokens } = await embed(
    targets.map((t) => t.text),
    "document",
  );
  const rows = targets.flatMap((entity, i) => (vectors[i] ? [{ entity, embedding: vectors[i] as number[] }] : []));
  if (rows.length < targets.length) throw new Error(`${targets.length - rows.length} entries have no recorded vector; record the index again with a Voyage key.`);
  await rebuildIndex(db ?? (await getDb()), rows, e.id);
  return { rows: rows.length, embedder: e.id, tokens };
}

export type Retrieval = { source: SourceEntity; candidates: Candidate[]; vectorUsed: boolean };

/** Hybrid retrieval for every source item: vectors (when the query can be embedded in the index's space) plus keywords, fused by rank. */
export async function retrieveAll(given?: Db, only?: SourceEntity[]): Promise<Retrieval[]> {
  const db = given ?? (await getDb());
  const state = await indexState(db);
  if (!state.rows || !state.embedder) throw new Error("Build the index first.");
  const sources = only ?? sourceEntities(source);
  const e = embedder();
  const sameSpace = e.id === state.embedder;
  const { vectors } = sameSpace ? await embed(sources.map((s) => s.text), "query") : { vectors: sources.map(() => null) };
  return Promise.all(
    sources.map(async (s, i) => {
      const q = vectors[i];
      const [vec, kw] = await Promise.all([q ? vectorSearch(db, s.contentType, state.embedder as string, q) : Promise.resolve([]), keywordSearch(db, s.contentType, s.text)]);
      return { source: s, candidates: fuse(vec, kw, byId), vectorUsed: Boolean(q) };
    }),
  );
}

export type Proposal = Retrieval & { decision: LinkDecision; problems: string[] };

/**
 * Rules first; the rest goes to Claude in one call per content type, with
 * each item's candidates. Every model decision is checked; one that fails
 * keeps its problems and waits for a person.
 */
export async function proposeLinks(given?: Db, only?: SourceEntity[]): Promise<{ proposals: Proposal[]; calls: number }> {
  const db = given ?? (await getDb());
  const retrieved = await retrieveAll(db, only);
  const proposals: Proposal[] = [];
  const open: Retrieval[] = [];
  for (const r of retrieved) {
    const d = ruleDecision(r.source, r.candidates);
    if (d) proposals.push({ ...r, decision: d, problems: [] });
    else open.push(r);
  }
  let calls = 0;
  const callIds = new Map<string, number>();
  for (const type of ["author", "topic"] as TargetKind[]) {
    const batch = open.filter((r) => r.source.contentType === type);
    if (!batch.length) continue;
    const schema = decisionSchema(
      batch.map((r) => r.source.key),
      [...new Set(batch.flatMap((r) => r.candidates.map((c) => c.entryId)))],
    );
    const result = await structured({ purpose: `${type} linking`, promptVersion: LINK_PROMPT_VERSION, system: LINK_SYSTEM, user: linkUser(batch), schema, maxTokens: 8000, effort: "medium" });
    const call = await logCall(db, `${type} linking`, LINK_PROMPT_VERSION, result);
    calls++;
    for (const r of batch) {
      const answer = result.output.decisions.find((d) => d.source === r.source.key);
      callIds.set(r.source.key, call.id);
      if (!answer) {
        proposals.push({ ...r, decision: { source: r.source.key, decision: "skip", entryId: null, reason: "Claude gave no decision.", evidence: "", decidedBy: "claude" }, problems: ["No decision returned for this item"] });
        continue;
      }
      const decision: LinkDecision = { ...answer, entryId: answer.entryId ?? null, decidedBy: "claude" };
      proposals.push({ ...r, decision, problems: checkDecision(r.source, r.candidates, decision) });
    }
  }
  proposals.sort((a, b) => a.source.key.localeCompare(b.source.key));
  await saveLinkProposals(
    db,
    proposals.map((p) => ({ decision: p.decision, contentType: p.source.contentType, problems: p.problems, callId: callIds.get(p.source.key) ?? null, candidates: p.candidates, vectorUsed: p.vectorUsed })),
  );
  return { proposals, calls };
}
