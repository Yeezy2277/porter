"use server";

import { revalidatePath } from "next/cache";
import { Mapping } from "@/core/mapping";
import { getDb } from "@/db/client";
import { approve, resetMapping, saveProposal } from "@/db/repo";
import { LlmError } from "@/lib/llm";
import { proposeMapping, problemsFor } from "@/lib/map";
import { model } from "@/config/demo";

export type ActionState = { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

const ctId = (form: FormData) => {
  const id = String(form.get("contentType") ?? "");
  if (!model.some((c) => c.sys.id === id)) throw new Error("Unknown content type");
  return id;
};

export async function proposeAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { call, problems } = await proposeMapping(ctId(form));
    revalidatePath("/map");
    const errors = problems.filter((p) => p.severity === "error").length;
    return {
      status: "ok",
      message: `${call.mode === "live" ? "Claude proposed" : "Replayed a recorded proposal"}: ${errors ? `${errors} problem${errors > 1 ? "s" : ""} to fix before approval` : "no problems found by the checks"}.`,
    };
  } catch (e) {
    return { status: "error", message: e instanceof LlmError ? e.message : "The proposal failed. Try again; /api/health shows what is configured." };
  }
}

export async function saveMappingAction(_: ActionState, form: FormData): Promise<ActionState> {
  let mapping: Mapping;
  try {
    mapping = Mapping.parse(JSON.parse(String(form.get("mapping") ?? "")));
  } catch {
    return { status: "error", message: "The mapping couldn't be read. Reload the page and try again." };
  }
  if (mapping.contentType !== ctId(form)) return { status: "error", message: "The mapping is for a different content type." };
  await saveProposal(await getDb(), mapping, null);
  revalidatePath("/map");
  const errors = problemsFor(mapping).filter((p) => p.severity === "error").length;
  return { status: "ok", message: errors ? `Saved. ${errors} problem${errors > 1 ? "s" : ""} left before it can be approved.` : "Saved. Ready to approve." };
}

export async function approveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const db = await getDb();
  const id = ctId(form);
  const { getMapping } = await import("@/db/repo");
  const current = await getMapping(db, id);
  if (!current) return { status: "error", message: "There is no mapping to approve yet." };
  // The server re-checks: a hidden button is not the protection.
  if (problemsFor(current.mapping).some((p) => p.severity === "error")) return { status: "error", message: "Fix the problems marked in red first." };
  const row = await approve(db, id, String(form.get("seen") ?? ""));
  if (!row) return { status: "error", message: "The mapping changed since you loaded it. Review the new version, then approve." };
  revalidatePath("/map");
  return { status: "ok", message: "Approved. Stage 04 will apply this mapping to every post." };
}

export async function resetAction(_: ActionState, form: FormData): Promise<ActionState> {
  await resetMapping(await getDb(), ctId(form));
  revalidatePath("/map");
  return { status: "ok", message: "Cleared. Ask Claude for a new proposal." };
}

// Stage 03: linking

function linkError(e: unknown, what: string): ActionState {
  const msg = e instanceof Error && /^(No recorded|The recorded|Claude|Anthropic|The Anthropic|Voyage|The Voyage|Build the index|\d+ entries have no)/.test(e.message) ? e.message : `${what} failed. Try again; /api/health shows what is configured.`;
  return { status: "error", message: msg };
}

export async function buildIndexAction(_: ActionState): Promise<ActionState> {
  try {
    const { buildIndex } = await import("@/lib/link");
    const r = await buildIndex();
    revalidatePath("/link");
    return { status: "ok", message: `Indexed ${r.rows} entries with ${r.embedder}${r.tokens ? ` (${r.tokens} tokens)` : ""}.` };
  } catch (e) {
    return linkError(e, "Indexing");
  }
}

export async function proposeLinksAction(_: ActionState): Promise<ActionState> {
  try {
    const { proposeLinks } = await import("@/lib/link");
    const { proposals, calls } = await proposeLinks();
    revalidatePath("/link");
    const byRule = proposals.filter((p) => p.decision.decidedBy === "rule").length;
    const flagged = proposals.filter((p) => p.problems.length).length;
    return { status: "ok", message: `${proposals.length} items: ${byRule} settled by rules, ${proposals.length - byRule} by Claude in ${calls} call${calls === 1 ? "" : "s"}${flagged ? `, ${flagged} flagged for you` : ""}.` };
  } catch (e) {
    return linkError(e, "Linking");
  }
}

export async function overrideLinkAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { getLinks, overrideLink } = await import("@/db/search");
  const db = await getDb();
  const key = String(form.get("source") ?? "");
  const choice = String(form.get("choice") ?? "");
  const row = (await getLinks(db)).find((r) => r.sourceKey === key);
  if (!row) return { status: "error", message: "That item isn't in the current proposal. Reload the page." };
  // A person may pick any existing entry of the right type (fixing a retrieval miss), "new" or "skip".
  // Claude is limited to what was retrieved; a reviewer isn't. Still checked here, not in the UI.
  const { targets } = await import("@/lib/link");
  const allowed = new Set([...targets.filter((t) => t.contentType === row.contentType).map((t) => `link:${t.entryId}`), "skip", ...(key.startsWith("tag:") ? [] : ["new"])]);
  if (!allowed.has(choice)) return { status: "error", message: "Pick one of the listed options." };
  const [decision, entryId] = choice.startsWith("link:") ? (["link", choice.slice(5)] as const) : ([choice as "new" | "skip", null] as const);
  await overrideLink(db, key, decision, entryId);
  revalidatePath("/link");
  return { status: "ok", message: "Changed." };
}

export async function approveLinksAction(_: ActionState): Promise<ActionState> {
  const { approveLinks } = await import("@/db/search");
  const r = await approveLinks(await getDb());
  revalidatePath("/link");
  revalidatePath("/map");
  if ("blocked" in r) return { status: "error", message: `Decide the ${r.blocked.length} flagged item${r.blocked.length > 1 ? "s" : ""} first: ${r.blocked.join(", ")}.` };
  return { status: "ok", message: `Approved ${r.approved} decisions. The mapping's dry run now links authors and topics.` };
}

export async function resetLinksAction(_: ActionState): Promise<ActionState> {
  const { resetLinks } = await import("@/db/search");
  await resetLinks(await getDb());
  revalidatePath("/link");
  return { status: "ok", message: "Cleared." };
}
