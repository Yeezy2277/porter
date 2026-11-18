import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { model, source } from "@/config/demo";
import { getDb } from "@/db/client";
import { serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Booleans and counts only, never values. */
export async function GET() {
  let env;
  try {
    env = serverEnv();
  } catch {
    return NextResponse.json({ ok: false, env: false }, { status: 503 });
  }
  let database = false;
  try {
    await (await getDb()).execute(sql`select 1`);
    database = true;
  } catch {
    database = false;
  }
  return NextResponse.json(
    { ok: database, env: true, database, postgres: env.databaseUrl ? "neon" : "pglite", claude: env.live ? "live" : "replay", samples: { posts: source.posts.length, contentTypes: model.length } },
    { status: database ? 200 : 503 },
  );
}
