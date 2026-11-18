/**
 * Porter's eval runner.
 *
 *   npm run eval -- linking     53 linking cases through proposeLinks
 *   npm run eval -- agent       19 posts through runAgent, graded by code and a Haiku judge
 *   npm run eval -- calibrate   judge vs your labels (samples/evals/labels.json)
 *   npm run eval -- negatives   the judge on known-bad inputs (empty, "I don't know", wrong article)
 *
 * Everything replays from recordings by default, even with keys in .env. To record a new run:
 * PORTER_RECORD=true PORTER_REPLAY_FIRST=true npm run eval -- <flow> --live (keys in .env).
 * Output follows the eval-report contract: evals/<flow>/baseline/{results.jsonl, traces/, _state.json}
 * plus summary.json, which the app's /evals page reads.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import linkingJson from "../samples/evals/linking.json";
import plantedJson from "../samples/evals/judge-planted.json";
import { contentType } from "@/core/model";
import { visibleText } from "@/core/grounding";
import { migratable } from "@/core/source";
import { slugify } from "@/core/text";
import type { SourceEntity } from "@/core/link";
import { model } from "@/config/demo";
import { runAgent } from "@/lib/agent";
import { proposeLinks } from "@/lib/link";
import { resolver } from "@/lib/map";
import { structured, turn, type Usage } from "@/lib/llm";
import { embedder } from "@/lib/embed";
import { serverEnv } from "@/lib/env";
import { LINK_PROMPT_VERSION } from "@/prompts/link";
import { AGENT_PROMPT_VERSION } from "@/prompts/agent";
import { agentCases, demoState } from "@/evals/setup";
import {
  agreement,
  answerOf,
  CRITERIA,
  gradeAgent,
  gradeLinking,
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM,
  JudgeVerdict,
  judgeUser,
  LinkingCase,
  rate,
  type Criterion,
} from "@/evals/grade";

const JUDGE_MODEL = "claude-haiku-5-5";
const ROOT = join(process.cwd(), "evals");

type Row = { prompt_id: string; prompt: string; tags: string[]; status: "ok" | "error"; stop_reason: string; grade: Record<string, number>; model: string; usage?: Usage; latency_s?: number; meta?: unknown };
type Turn = { role: "system" | "user" | "assistant" | "tool_call" | "tool_result"; content: string; name?: string };

async function writeRun(flow: string, metrics: { id: string; label: string; kind: "binary" }[], rows: Row[], traces: Map<string, Turn[]>, summary: object) {
  const dir = join(ROOT, flow, "baseline");
  await rm(join(dir, "traces"), { recursive: true, force: true });
  await mkdir(join(dir, "traces"), { recursive: true });
  await writeFile(join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const [id, t] of traces) await writeFile(join(dir, "traces", `${id}_rep0.json`), JSON.stringify(t, null, 1));
  await writeFile(join(ROOT, flow, "_state.json"), JSON.stringify({ metrics }, null, 2) + "\n");
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

const pct = (r: { mean: number; ci: number; n: number }) => `${Math.round(r.mean * 100)}% ±${Math.round(r.ci * 100)} (n=${r.n})`;

// ---------------------------------------------------------------- linking

async function linking() {
  const cases = linkingJson.cases.map((c) => LinkingCase.parse(c));
  const entities: SourceEntity[] = cases.map((c) => ({
    key: c.id,
    contentType: c.kind === "author" ? "author" : "topic",
    kind: c.kind,
    name: c.name,
    slug: slugify(c.name),
    text: c.kind === "author" ? `Author: ${c.name}${c.bio ? `. ${c.bio}` : ""}` : `${c.kind === "category" ? "Category" : "Tag"}: ${c.name}`,
    posts: 1,
  }));
  const { db } = await demoState();
  const { proposals } = await proposeLinks(db, entities);
  const { recentCalls } = await import("@/db/repo");
  const calls = (await recentCalls(db, 3)).filter((c) => c.promptVersion === LINK_PROMPT_VERSION).slice(0, 2);

  const rows: Row[] = [];
  const traces = new Map<string, Turn[]>();
  for (const c of cases) {
    const p = proposals.find((x) => x.source.key === c.id);
    if (!p) throw new Error(`No proposal for ${c.id}`);
    const g = gradeLinking(c, p.decision, p.candidates);
    rows.push({
      prompt_id: c.id,
      prompt: p.source.text,
      tags: c.tags,
      status: "ok",
      stop_reason: "end_turn",
      grade: { correct: g.correct, by_rule: g.byRule, ...(g.retrieval === null ? {} : { retrieval: g.retrieval }) },
      model: p.decision.decidedBy === "rule" ? "rule" : (calls[0]?.model ?? "claude-opus-5-5"),
      meta: { answer: answerOf(p.decision), accept: c.accept, decidedBy: p.decision.decidedBy, problems: p.problems },
    });
    traces.set(c.id, [
      { role: "user", content: p.source.text },
      { role: "tool_result", content: p.candidates.map((x) => `${x.entryId}: ${x.text} (cos ${x.similarity ?? "–"}, kw #${x.keywordRank ?? "–"})`).join("\n") || "(nothing retrieved)" },
      { role: "assistant", content: `${answerOf(p.decision)} (${p.decision.decidedBy})\n${p.decision.reason}\nEvidence: ${p.decision.evidence}${p.problems.length ? `\nProblems: ${p.problems.join("; ")}` : ""}` },
    ]);
  }
  const correct = rate(rows.map((r) => r.grade.correct as 0 | 1));
  const retrieval = rate(rows.filter((r) => "retrieval" in r.grade).map((r) => r.grade.retrieval as 0 | 1));
  const group = (i: number) =>
    Object.fromEntries([...new Set(cases.map((c) => c.tags[i] as string))].sort().map((t) => [t, rate(rows.filter((r) => r.tags[i] === t).map((r) => r.grade.correct as 0 | 1))]));
  // Of the misses, which came from retrieval (the right entry never reached the model) and which from the decision.
  const misses = rows.filter((r) => !r.grade.correct).map((r) => ({ id: r.prompt_id, prompt: r.prompt, ...(r.meta as object), cause: r.grade.retrieval === 0 ? "retrieval" : "decision" }));
  const summary = {
    flow: "linking",
    promptVersion: LINK_PROMPT_VERSION,
    embedder: embedder().id,
    model: calls[0]?.model ?? null,
    cases: rows.length,
    correct,
    retrieval,
    byRule: rate(rows.map((r) => r.grade.by_rule as 0 | 1)),
    byKind: group(0),
    byDifficulty: group(1),
    misses,
    cost: { calls: calls.length, micros: calls.reduce((s, c) => s + c.costMicros, 0), modes: [...new Set(calls.map((c) => c.mode))] },
  };
  await writeRun("linking", [
    { id: "correct", label: "Correct", kind: "binary" },
    { id: "retrieval", label: "Retrieval@5", kind: "binary" },
    { id: "by_rule", label: "By rule", kind: "binary" },
  ], rows, traces, summary);
  await check("linking", { correct, retrieval });
  console.log(`linking: correct ${pct(correct)} · retrieval ${pct(retrieval)} · misses ${misses.map((m) => `${m.id} (${m.cause})`).join(", ") || "none"}`);
}

// ---------------------------------------------------------------- agent

async function judge(field: "summary" | "seoDescription", text: string, article: string) {
  return structured({ purpose: "judge", promptVersion: JUDGE_PROMPT_VERSION, system: JUDGE_SYSTEM, user: judgeUser(field, text, article), schema: JudgeVerdict, maxTokens: 2000, effort: "low", model: JUDGE_MODEL });
}

async function agent() {
  const { source, gold } = agentCases();
  const ct = contentType(model, "article");
  const { mapping, links } = await demoState();
  const rows: Row[] = [];
  const traces = new Map<string, Turn[]>();
  const judgeItems: object[] = [];
  let judgeMicros = 0;
  for (const post of source.posts.filter((p) => migratable(p).ok)) {
    const g = gold.get(post.id);
    if (!g) throw new Error(`No gold for post ${post.id}`);
    const out = await runAgent({ post, mapping, links, runId: 0 }, { turn, emit: () => {} });
    // The judge sees what the agent saw (read_post): title, excerpt and body. Grading against less
    // would fail true statements the agent took from the excerpt.
    const article = [post.title, post.excerpt && `Excerpt: ${post.excerpt}`, visibleText(post.html)].filter(Boolean).join("\n\n");
    const sourceText = [post.title, post.excerpt, post.seoDescription, visibleText(post.html)].join("\n");
    const grade: Record<string, number> = { ...gradeAgent(out, g, ct, sourceText, resolver) };

    const judged: Record<Criterion, number[]> = { faithful: [], specific: [], plain: [], purpose: [] };
    for (const field of ["summary", "seoDescription"] as const) {
      const text = out.draft.fields[field];
      if (out.provenance[field]?.origin !== "agent" || typeof text !== "string") continue;
      const v = await judge(field, text, article);
      judgeMicros += v.costMicros;
      for (const c of CRITERIA) judged[c].push(v.output[c].pass ? 1 : 0);
      judgeItems.push({ id: `${post.id}:${field}`, postId: post.id, title: post.title, field, text, article, verdict: v.output });
    }
    for (const c of CRITERIA) if (judged[c].length) grade[c] = judged[c].reduce((s, x) => s + x, 0) / judged[c].length;

    rows.push({
      prompt_id: String(post.id),
      prompt: post.title,
      tags: [post.id < 1300 ? "demo" : "eval", ...g.traps],
      status: "ok",
      stop_reason: out.status,
      grade,
      model: serverEnv().live?.model ?? "claude-opus-5-5",
      usage: { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, cacheReadTokens: out.usage.cacheReadTokens, cacheWriteTokens: 0 },
      meta: { status: out.status, turns: out.turns, costMicros: out.usage.costMicros, region: out.draft.fields.region ?? null, acceptRegion: g.region, written: Object.entries(out.provenance).filter(([, p]) => p.origin === "agent").map(([f]) => [f, out.draft.fields[f]]), notes: out.notes },
    });
    traces.set(String(post.id), [
      { role: "user", content: `Migrate post ${post.id}: "${post.title}".` },
      ...out.events.flatMap((e): Turn[] =>
        e.type === "tool" ? [{ role: "tool_call", name: e.name, content: JSON.stringify(e.input, null, 2) }, { role: "tool_result", content: `${e.ok ? "ok" : "rejected"}: ${e.summary}` }] : e.type === "note" ? [{ role: "assistant", content: e.text }] : [],
      ),
      { role: "assistant", content: `${out.status}: ${out.reason}${out.notes ? `\nNote: ${out.notes}` : ""}` },
    ]);
    console.log(`  ${post.id} ${out.status} · ${out.turns} turns · ${JSON.stringify(grade)}`);
  }
  // Planted flawed texts join the calibration pool (not the agent's scores), so labels aren't all "pass".
  for (const p of plantedJson.items) {
    const post = source.posts.find((x) => x.id === p.postId);
    if (!post) throw new Error(`Planted item for unknown post ${p.postId}`);
    const article = [post.title, post.excerpt && `Excerpt: ${post.excerpt}`, visibleText(post.html)].filter(Boolean).join("\n\n");
    const v = await judge(p.field as "summary" | "seoDescription", p.text, article);
    judgeMicros += v.costMicros;
    judgeItems.push({ id: p.id, postId: p.postId, title: post.title, field: p.field, text: p.text, article, verdict: v.output, planted: p.flaw });
  }
  const metric = (id: string) => rate(rows.filter((r) => id in r.grade).map((r) => (r.grade[id] as number) >= 1 ? 1 : 0));
  const summary = {
    flow: "agent",
    promptVersion: AGENT_PROMPT_VERSION,
    judge: { model: JUDGE_MODEL, promptVersion: JUDGE_PROMPT_VERSION, micros: judgeMicros },
    posts: rows.length,
    metrics: Object.fromEntries(["submitted", "rules", "grounded", "region", ...CRITERIA].map((m) => [m, metric(m)])),
    turns: { mean: rows.reduce((s, r) => s + (r.meta as { turns: number }).turns, 0) / rows.length, max: Math.max(...rows.map((r) => (r.meta as { turns: number }).turns)) },
    cost: { agentMicros: rows.reduce((s, r) => s + (r.meta as { costMicros: number }).costMicros, 0), judgeMicros },
    misses: rows.filter((r) => Object.values(r.grade).some((v) => v < 1)).map((r) => ({ id: r.prompt_id, title: r.prompt, grade: r.grade, meta: r.meta })),
  };
  await writeRun("agent", [
    { id: "submitted", label: "Submitted", kind: "binary" },
    { id: "region", label: "Region", kind: "binary" },
    { id: "grounded", label: "Grounded", kind: "binary" },
    { id: "rules", label: "Rules", kind: "binary" },
    ...CRITERIA.map((c) => ({ id: c, label: `Judge: ${c}`.slice(0, 14), kind: "binary" as const })),
  ], rows, traces, summary);
  await writeFile(join(ROOT, "agent", "baseline", "judge-items.json"), JSON.stringify(judgeItems, null, 1) + "\n");
  await check("agent", summary.metrics);
  console.log(`agent: ${Object.entries(summary.metrics).map(([k, v]) => `${k} ${pct(v)}`).join(" · ")}`);
}

// ---------------------------------------------------------------- judge checks

async function calibrate() {
  const items = JSON.parse(await readFile(join(ROOT, "agent", "baseline", "judge-items.json"), "utf8")) as { id: string; verdict: Record<Criterion, { pass: boolean }> }[];
  const labels = JSON.parse(await readFile(join(process.cwd(), "samples", "evals", "labels.json"), "utf8")) as { judgePromptVersion: string; labels: Record<string, Record<Criterion, boolean>> };
  const pairs = items.filter((i) => labels.labels[i.id]).map((i) => ({ id: i.id, judge: Object.fromEntries(CRITERIA.map((c) => [c, i.verdict[c].pass])) as Record<Criterion, boolean>, human: labels.labels[i.id] as Record<Criterion, boolean> }));
  const a = agreement(pairs);
  const disagreements = pairs.flatMap((p) => CRITERIA.filter((c) => p.judge[c] !== p.human[c]).map((c) => ({ id: p.id, criterion: c, judge: p.judge[c], human: p.human[c] })));
  await mkdir(join(ROOT, "judge"), { recursive: true });
  await writeFile(join(ROOT, "judge", "calibration.json"), JSON.stringify({ judgeModel: JUDGE_MODEL, judgePromptVersion: JUDGE_PROMPT_VERSION, labelledItems: pairs.length, ...a, disagreements }, null, 2) + "\n");
  console.log(`judge vs human: ${Math.round(a.rate * 100)}% agreement over ${pairs.length} items × ${CRITERIA.length} criteria; ${CRITERIA.map((c) => `${c} ${a.per[c].agree}/${a.per[c].n}`).join(", ")}`);
}

async function negatives() {
  const article = "Porto's Bolhão market reopened in September after four years of restoration. Go on a weekday morning for fish and flowers.";
  const bad = [
    ["empty", ""],
    ["dont-know", "I don't know."],
    ["wrong-article", "Ten tips for skiing in the Swiss Alps this winter, from lift passes to the best mountain huts."],
    ["hype", "The ULTIMATE must-see market in Europe!!! You won't believe what's inside!"],
  ] as const;
  const out: Record<string, Record<Criterion, boolean>> = {};
  for (const [id, text] of bad) {
    const v = await judge("summary", text, article);
    out[id] = Object.fromEntries(CRITERIA.map((c) => [c, v.output[c].pass])) as Record<Criterion, boolean>;
    console.log(`  ${id}: ${CRITERIA.map((c) => `${c}=${v.output[c].pass ? "pass" : "fail"}`).join(" ")}`);
  }
  // Every known-bad input must fail at least one criterion, and the empty one must fail all.
  const ok = Object.values(out).every((r) => CRITERIA.some((c) => !r[c])) && CRITERIA.every((c) => !out.empty?.[c]);
  await mkdir(join(ROOT, "judge"), { recursive: true });
  await writeFile(join(ROOT, "judge", "negatives.json"), JSON.stringify({ judgeModel: JUDGE_MODEL, judgePromptVersion: JUDGE_PROMPT_VERSION, ok, results: out }, null, 2) + "\n");
  console.log(ok ? "negatives: every known-bad input failed" : "negatives: THE JUDGE PASSED A KNOWN-BAD INPUT");
  if (!ok) process.exitCode = 1;
}

/** Fails the run when a metric drops below its floor in evals/thresholds.json. */
async function check(flow: "linking" | "agent", metrics: Record<string, { mean: number }>) {
  const floors = (JSON.parse(await readFile(join(ROOT, "thresholds.json"), "utf8")) as Record<string, Record<string, number>>)[flow] ?? {};
  const below = Object.entries(floors).filter(([m, floor]) => (metrics[m]?.mean ?? 0) < floor);
  for (const [m, floor] of below) console.error(`  ${flow}.${m} = ${Math.round((metrics[m]?.mean ?? 0) * 100)}% is below its floor of ${Math.round(floor * 100)}%`);
  if (below.length) process.exitCode = 1;
}

const flows: Record<string, () => Promise<void>> = { linking, agent, calibrate, negatives };
const which = process.argv[2] ?? "";

async function main() {
  // Replay unless asked: a stray `npm run eval` with keys in .env must not spend money.
  if (!process.argv.includes("--live")) {
    process.env.ANTHROPIC_API_KEY = "";
    process.env.VOYAGE_API_KEY = "";
  }
  const flow = flows[which];
  if (!flow) {
    console.error(`Usage: npm run eval -- ${Object.keys(flows).join("|")}`);
    process.exit(2);
  }
  console.log(`eval ${which}: ${serverEnv().live ? "live" : "replay"}${serverEnv().replayFirst ? " (replay first)" : ""}, embeddings ${embedder().mode}`);
  await flow();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
