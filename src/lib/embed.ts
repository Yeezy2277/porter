import { createHash } from "node:crypto";
import { z } from "zod";
import recordedJson from "../../samples/embeddings.json";
import { DIMENSIONS, HASHING_ID, hashingEmbed } from "@/core/hashing";
import { serverEnv } from "./env";

/**
 * Embeddings for retrieval. Anthropic doesn't offer an embedding model and
 * recommends Voyage AI, called here with fetch (one endpoint isn't worth an
 * SDK). Like model answers, vectors are recorded so the demo and CI work
 * without a key.
 *
 * Vectors from different models live in different spaces, so one embedder
 * is chosen for the whole index and every query: Voyage live, Voyage
 * replayed from recordings, or the local hashing stand-in. A query the
 * recordings don't cover returns null, and retrieval falls back to keywords
 * for it instead of comparing vectors from two spaces.
 */

export const VOYAGE_MODEL = "voyage-3.5-lite";
const VOYAGE_ID = `${VOYAGE_MODEL}-${DIMENSIONS}`;
export type InputType = "document" | "query";
export type Embedder = { id: string; mode: "live" | "replay" | "local" };

const recorded = recordedJson as { model: string; dimensions: number; vectors: Record<string, number[]> };
const keyOf = (inputType: InputType, text: string) => createHash("sha256").update(`${VOYAGE_ID}\n${inputType}\n${text}`).digest("hex").slice(0, 24);

export function embedder(): Embedder {
  const env = serverEnv();
  if (env.voyage) return { id: VOYAGE_ID, mode: "live" };
  if (recorded.model === VOYAGE_MODEL && recorded.dimensions === DIMENSIONS && Object.keys(recorded.vectors).length > 0) return { id: VOYAGE_ID, mode: "replay" };
  return { id: HASHING_ID, mode: "local" };
}

export class EmbedError extends Error {}

const VoyageResponse = z.object({ data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })), usage: z.object({ total_tokens: z.number() }) });

export async function embed(texts: readonly string[], inputType: InputType): Promise<{ vectors: (number[] | null)[]; tokens: number }> {
  const e = embedder();
  if (e.mode === "local") return { vectors: texts.map(hashingEmbed), tokens: 0 };
  if (e.mode === "replay") return { vectors: texts.map((t) => recorded.vectors[keyOf(inputType, t)] ?? null), tokens: 0 };

  const env = serverEnv();
  const out: (number[] | null)[] = [];
  let tokens = 0;
  // Voyage takes up to 128 inputs per request.
  for (let i = 0; i < texts.length; i += 128) {
    const batch = texts.slice(i, i + 128);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.voyage?.key}` },
      body: JSON.stringify({ input: batch, model: VOYAGE_MODEL, input_type: inputType, output_dimension: DIMENSIONS }),
    });
    if (res.status === 401) throw new EmbedError("The Voyage API key was rejected.");
    if (res.status === 429) throw new EmbedError("Voyage rate limit reached; try again in a minute.");
    if (!res.ok) throw new EmbedError(`Voyage API error ${res.status}.`);
    const parsed = VoyageResponse.parse(await res.json());
    tokens += parsed.usage.total_tokens;
    const byIndex = [...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding.map((x) => Math.round(x * 1e6) / 1e6));
    if (byIndex.length !== batch.length || byIndex.some((v) => v.length !== DIMENSIONS)) throw new EmbedError("Voyage returned an unexpected number or size of vectors.");
    out.push(...byIndex);
  }
  if (env.record) await record(texts, inputType, out as number[][]);
  return { vectors: out, tokens };
}

async function record(texts: readonly string[], inputType: InputType, vectors: number[][]): Promise<void> {
  if (process.env.VERCEL) return;
  const fs = await import("node:fs/promises");
  const path = (await import("node:path")).join(process.cwd(), "samples", "embeddings.json");
  const current = JSON.parse(await fs.readFile(path, "utf8")) as typeof recorded;
  texts.forEach((t, i) => (current.vectors[keyOf(inputType, t)] = vectors[i] as number[]));
  current.vectors = Object.fromEntries(Object.entries(current.vectors).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(path, `${JSON.stringify({ model: VOYAGE_MODEL, dimensions: DIMENSIONS, vectors: current.vectors })}\n`);
  Object.assign(recorded.vectors, current.vectors);
}
