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
