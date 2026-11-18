import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { serverEnv } from "@/lib/env";

/**
 * One database interface, two engines: Neon over HTTP in production and an
 * embedded PGlite file locally (and in-memory in tests), so the app runs with
 * no setup. Neon's HTTP driver has no interactive transactions, so the
 * repository never relies on them.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const g = globalThis as unknown as { __porterDb?: Promise<Db> };

async function open(): Promise<Db> {
  const env = serverEnv();
  if (env.databaseUrl) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle(neon(env.databaseUrl), { schema }) as unknown as Db;
  }
  if (process.env.VERCEL) throw new Error("DATABASE_URL is required on Vercel; local PGlite storage doesn't persist there.");
  return openPglite(".data/pglite");
}

/** Embedded Postgres with migrations applied; `dataDir` undefined means in-memory. */
export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) (await import("node:fs")).mkdirSync(dataDir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite(dataDir), { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return db as unknown as Db;
}

export function getDb(): Promise<Db> {
  g.__porterDb ??= open().catch((err) => {
    g.__porterDb = undefined;
    throw err;
  });
  return g.__porterDb;
}
