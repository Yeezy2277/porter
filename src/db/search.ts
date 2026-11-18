import { and, asc, eq, sql } from "drizzle-orm";
import { searchText, type Candidate, type LinkDecision, type TargetEntity, type TargetKind } from "@/core/link";
import type { Db } from "./client";
import { entities, links, type EntityRow, type LinkRow } from "./schema";

/** Replaces the index with these entities and vectors (a few dozen rows; a real space would upsert in batches). */
export async function rebuildIndex(db: Db, rows: { entity: TargetEntity; embedding: number[] }[], embedderId: string): Promise<void> {
  await db.delete(entities);
  if (!rows.length) return;
  await db.insert(entities).values(
    rows.map(({ entity, embedding }) => ({
      entryId: entity.entryId,
      contentType: entity.contentType,
      name: entity.name,
      text: entity.text,
      searchText: searchText(entity.text),
      embedder: embedderId,
      embedding,
    })),
  );
}

export async function indexState(db: Db): Promise<{ rows: number; embedder: string | null }> {
  const [row] = await db.select({ rows: sql<number>`count(*)::int`, embedder: sql<string | null>`min(${entities.embedder})` }).from(entities);
  return { rows: Number(row?.rows ?? 0), embedder: row?.embedder ?? null };
}

export async function allEntities(db: Db): Promise<EntityRow[]> {
  return db.select().from(entities).orderBy(asc(entities.entryId));
}

/** Nearest neighbours by cosine distance (`<=>`), only among vectors from the same embedder. */
export async function vectorSearch(db: Db, contentType: TargetKind, embedderId: string, query: number[], k = 5): Promise<{ entryId: string; similarity: number }[]> {
  const distance = sql<number>`${entities.embedding} <=> ${JSON.stringify(query)}::vector`;
  const rows = await db
    .select({ entryId: entities.entryId, distance })
    .from(entities)
    .where(and(eq(entities.contentType, contentType), eq(entities.embedder, embedderId)))
    .orderBy(distance)
    .limit(k);
  return rows.map((r) => ({ entryId: r.entryId, similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000 }));
}

/**
 * Full-text match on the normalised text, any word (OR), ranked by ts_rank.
 * Words are [a-z0-9] only after normalisation, so they're safe to join into a
 * tsquery; the query still goes in as a parameter.
 */
export async function keywordSearch(db: Db, contentType: TargetKind, text: string, k = 5): Promise<{ entryId: string; rank: number }[]> {
  // The "Author:" / "Tag:" labels help embeddings but would match every row here.
  const terms = [...new Set(searchText(text.replace(/^(author|topic|category|tag):\s*/i, "")).split(" ").filter((w) => w.length > 1))];
  if (!terms.length) return [];
  const query = sql`to_tsquery('english', ${terms.join(" | ")})`;
  const doc = sql`to_tsvector('english', ${entities.searchText})`;
  const rank = sql<number>`ts_rank(${doc}, ${query})`;
  const rows = await db
    .select({ entryId: entities.entryId, rank })
    .from(entities)
    .where(and(eq(entities.contentType, contentType), sql`${doc} @@ ${query}`))
    .orderBy(sql`${rank} desc`, asc(entities.entryId))
    .limit(k);
  return rows.map((r) => ({ entryId: r.entryId, rank: Number(r.rank) }));
}

export async function getLinks(db: Db): Promise<LinkRow[]> {
  return db.select().from(links).orderBy(asc(links.sourceKey));
}

export async function saveLinkProposals(db: Db, rows: { decision: LinkDecision; contentType: TargetKind; problems: string[]; callId: number | null; candidates?: Candidate[]; vectorUsed?: boolean }[]): Promise<void> {
  await db.delete(links);
  if (!rows.length) return;
  await db.insert(links).values(
    rows.map(({ decision: d, contentType, problems, callId, candidates = [], vectorUsed = true }) => ({
      sourceKey: d.source,
      contentType,
      decision: d.decision,
      entryId: d.entryId,
      decidedBy: d.decidedBy,
      reason: d.reason,
      evidence: d.evidence,
      problems,
      callId,
      candidates,
      vectorUsed: vectorUsed ? 1 : 0,
      status: "proposed" as const,
      updatedAt: new Date(),
    })),
  );
}

/** A person's override replaces the decision, clears the model's problems and drops approval for that row. */
export async function overrideLink(db: Db, sourceKey: string, decision: LinkDecision["decision"], entryId: string | null): Promise<LinkRow | null> {
  const [row] = await db
    .update(links)
    .set({ decision, entryId, decidedBy: "person", reason: "Chosen by a reviewer.", evidence: "", problems: [], status: "proposed", updatedAt: new Date() })
    .where(eq(links.sourceKey, sourceKey))
    .returning();
  return row ?? null;
}

/** Approves every row, unless any still has problems: those need a person first. */
export async function approveLinks(db: Db): Promise<{ approved: number } | { blocked: string[] }> {
  const rows = await getLinks(db);
  const blocked = rows.filter((r) => r.problems.length > 0).map((r) => r.sourceKey);
  if (blocked.length) return { blocked };
  await db.update(links).set({ status: "approved" });
  return { approved: rows.length };
}

export async function resetLinks(db: Db): Promise<void> {
  await db.delete(links);
}
