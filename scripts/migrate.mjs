// Applies drizzle/ migrations to DATABASE_URL (Neon). Runs before `next build`
// on Vercel; locally the embedded PGlite migrates itself on first use.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

// Same lookup as src/lib/env.ts: DATABASE_URL, POSTGRES_URL, or either with a prefix.
const env = process.env;
const prefixed = Object.keys(env).filter((k) => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && env[k]?.trim()).sort()[0];
const url = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || (prefixed ? env[prefixed]?.trim() : undefined);
if (!url) {
  if (env.VERCEL) {
    console.error("db:migrate: no database connection string on Vercel. Connect Neon (Storage) and enable it for this environment.");
    process.exit(1);
  }
  console.log("db:migrate: no DATABASE_URL, skipping (local PGlite migrates on startup).");
  process.exit(0);
}
await migrate(drizzle(neon(url)), { migrationsFolder: "drizzle" });
console.log("db:migrate: up to date.");
