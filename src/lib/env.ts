import { z } from "zod";

/**
 * Server env, validated once. Everything is optional: with nothing set the
 * app runs on embedded Postgres and recorded model responses.
 */

const opt = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const Env = z
  .object({
    DATABASE_URL: opt,
    ANTHROPIC_API_KEY: opt,
    PORTER_MODEL: opt,
    PORTER_LIVE: opt,
    PORTER_RECORD: opt,
  })
  .superRefine((e, ctx) => {
    if (e.DATABASE_URL && !/^postgres(ql)?:\/\//.test(e.DATABASE_URL)) ctx.addIssue({ code: "custom", message: "DATABASE_URL must be a postgres:// connection string" });
    if (e.ANTHROPIC_API_KEY && !e.ANTHROPIC_API_KEY.startsWith("sk-ant-")) ctx.addIssue({ code: "custom", message: "ANTHROPIC_API_KEY doesn't look like an Anthropic key" });
  });

/** `true`, ` "true" `, `1`, `yes`, `on` → true. */
export function flag(v: string | undefined): boolean {
  return /^\s*["']?\s*(true|1|yes|on)\s*["']?\s*$/i.test(v ?? "");
}

export type ServerEnv = {
  databaseUrl: string | null;
  /** Live model calls: needs a key, and on Vercel an explicit PORTER_LIVE (a public demo must not spend money by default). */
  live: { model: string } | null;
  record: boolean;
};

export const DEFAULT_MODEL = "claude-opus-5-5";

export function databaseUrlFrom(source: Record<string, string | undefined>): string | undefined {
  const exact = source.DATABASE_URL?.trim() || source.POSTGRES_URL?.trim();
  if (exact) return exact;
  const key = Object.keys(source)
    .filter((k) => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && source[k]?.trim())
    .sort()[0];
  return key ? source[key]?.trim() : undefined;
}

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = Env.safeParse({ ...source, DATABASE_URL: databaseUrlFrom(source) });
  if (!parsed.success) throw new Error(`Invalid environment:\n  - ${parsed.error.issues.map((i) => i.message).join("\n  - ")}`);
  const e = parsed.data;
  const liveAllowed = Boolean(e.ANTHROPIC_API_KEY) && (!source.VERCEL || flag(e.PORTER_LIVE));
  return {
    databaseUrl: e.DATABASE_URL ?? null,
    live: liveAllowed ? { model: e.PORTER_MODEL ?? DEFAULT_MODEL } : null,
    record: flag(e.PORTER_RECORD),
  };
}

let cached: ServerEnv | null = null;
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}
