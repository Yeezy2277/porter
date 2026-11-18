import { NextResponse } from "next/server";
import { model, source } from "@/config/demo";

export const dynamic = "force-dynamic";

/** Booleans and counts only, never values. Grows with each stage (database, Claude, embeddings). */
export async function GET() {
  return NextResponse.json({ ok: true, samples: { posts: source.posts.length, contentTypes: model.length } });
}
