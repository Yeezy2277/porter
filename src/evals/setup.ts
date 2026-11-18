import demoExport from "../../samples/northbound-export.json";
import evalPosts from "../../samples/evals/posts.json";
import { openPglite, type Db } from "@/db/client";
import { approve, logCall, saveProposal } from "@/db/repo";
import { approveLinks, getLinks } from "@/db/search";
import { parseExport, type SourceExport } from "@/core/source";
import type { Mapping } from "@/core/mapping";
import type { LinkRow } from "@/db/schema";
import { structured } from "@/lib/llm";
import { mappingCall } from "@/lib/map";
import { buildIndex, proposeLinks } from "@/lib/link";
import type { AgentGold } from "./grade";

/**
 * A fresh, isolated state for each eval run: an in-memory database with the
 * demo's approved mapping and links, built through the app's own entry
 * points. Nothing is shared between runs or with the app's database.
 */
export async function demoState(): Promise<{ db: Db; mapping: Mapping; links: LinkRow[] }> {
  const db = await openPglite();
  const proposal = await structured(mappingCall("article"));
  const row = await saveProposal(db, proposal.output, (await logCall(db, "field mapping", "map-v1", proposal)).id);
  await approve(db, "article", row.updatedAt.toISOString());
  await buildIndex(db);
  await proposeLinks(db);
  const approved = await approveLinks(db);
  if ("blocked" in approved) throw new Error(`Demo links have flagged items: ${approved.blocked.join(", ")}`);
  return { db, mapping: proposal.output, links: await getLinks(db) };
}

type EvalPost = (typeof evalPosts.posts)[number];

/** The demo export plus the eval posts (gold stripped), parsed the same way as the demo. */
export function agentCases(): { source: SourceExport; gold: Map<number, AgentGold> } {
  const extra = evalPosts.posts.map(({ gold: _gold, ...p }: EvalPost) => {
    void _gold;
    return p;
  });
  const source = parseExport({ ...demoExport, posts: [...demoExport.posts, ...extra] });
  const gold = new Map<number, AgentGold>([
    ...Object.entries(evalPosts.demoGold).map(([id, g]) => [Number(id), g as AgentGold] as const),
    ...evalPosts.posts.map((p: EvalPost) => [p.id, p.gold as AgentGold] as const),
  ]);
  return { source, gold };
}
