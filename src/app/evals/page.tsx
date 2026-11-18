import type { Metadata } from "next";
import Link from "next/link";
import linking from "../../../evals/linking/baseline/summary.json";
import agent from "../../../evals/agent/baseline/summary.json";
import calibration from "../../../evals/judge/calibration.json";
import negatives from "../../../evals/judge/negatives.json";
import { CRITERIA } from "@/evals/grade";

export const metadata: Metadata = { title: "Evals" };

type Rate = { mean: number; ci: number; n: number };
const pct = (r: Rate) => `${Math.round(r.mean * 100)}%`;
const usd = (m: number) => `$${(m / 1e6).toFixed(3)}`;

function Metric({ label, r, note }: { label: string; r: Rate; note?: string }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{pct(r)}</dd>
      <span>
        ±{Math.round(r.ci * 100)} pts · n={r.n}
        {note ? ` · ${note}` : ""}
      </span>
    </div>
  );
}

export default function EvalsPage() {
  const am = agent.metrics as Record<string, Rate>;
  const cal = calibration as { labelledItems: number; rate: number; n: number; per: Record<string, { agree: number; n: number }>; disagreements: { id: string; criterion: string; judge: boolean; human: boolean }[] };
  const misses = linking.misses as { id: string; prompt: string; answer: string; accept: string[]; cause: string }[];
  return (
    <div className="wrap page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Manifest</Link> <span aria-hidden="true">/</span> <span>Stage 05 · Evals</span>
      </nav>
      <header className="post__head">
        <p className="label">Stage 05 · measure</p>
        <h1 className="post__title">Evals</h1>
        <p className="lede">
          Two evals run through the app&apos;s real entry points on hand-labelled cases, graded by code wherever code can grade, and by a judge model only for writing quality.
          CI replays the recorded run on every pull request, so a prompt or code change that breaks a stage fails the build. Cases live in <code>samples/evals/</code>.
        </p>
      </header>

      <section className="section" aria-labelledby="link-title">
        <h2 id="link-title" className="h2">
          Linking · {linking.cases} cases
        </h2>
        <p className="muted">
          Prompt {linking.promptVersion} · {linking.model} · embeddings {linking.embedder} · {usd(linking.cost.micros)} per live run
        </p>
        <dl className="metrics">
          <Metric label="Correct decision" r={linking.correct} />
          <Metric label="Retrieval recall@5" r={linking.retrieval} note="right entry retrieved" />
          <Metric label="Settled by rules" r={linking.byRule} note="no model call" />
        </dl>
        <div className="manifest" role="region" aria-label="Linking accuracy by difficulty" tabIndex={0} style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Difficulty</th>
                <th scope="col">Correct</th>
                <th scope="col">Cases</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(linking.byDifficulty as Record<string, Rate>).map(([k, r]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="mono">{pct(r)}</td>
                  <td className="mono">{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {misses.length > 0 && (
          <ul className="checks">
            {misses.map((m) => (
              <li key={m.id} className="is-error">
                <span className="mono">{m.id}</span> “{m.prompt}”: answered <span className="mono">{m.answer}</span>, expected <span className="mono">{m.accept.join(" / ")}</span>. Cause:{" "}
                {m.cause === "retrieval" ? "retrieval never surfaced the right entry" : "the decision"}.
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="agent-title">
        <h2 id="agent-title" className="h2">
          Agent · {agent.posts} posts
        </h2>
        <p className="muted">
          Prompt {agent.promptVersion} · {agent.turns.mean.toFixed(1)} turns on average (max {agent.turns.max}) · agent {usd(agent.cost.agentMicros)} + judge {usd(agent.cost.judgeMicros)} (
          {agent.judge.model}) per live run
        </p>
        <dl className="metrics">
          <Metric label="Submitted" r={am.submitted!} />
          <Metric label="Field rules" r={am.rules!} note="code" />
          <Metric label="Grounded" r={am.grounded!} note="code" />
          <Metric label="Region" r={am.region!} note="vs gold" />
          {CRITERIA.map((c) => (
            <Metric key={c} label={`Judge: ${c}`} r={am[c]!} note="Haiku" />
          ))}
        </dl>
        <p className="action__msg">
          Every metric is at or near its ceiling. On these cases the evals guard against regressions; showing that a new prompt is better would need harder cases.
        </p>
      </section>

      <section className="section" aria-labelledby="judge-title">
        <h2 id="judge-title" className="h2">
          Is the judge trustworthy?
        </h2>
        <ul className="checks">
          <li className={negatives.ok ? "is-ok" : "is-error"}>
            Known-bad inputs (empty, &ldquo;I don&apos;t know&rdquo;, the wrong article, hype): {negatives.ok ? "every one failed, as it should." : "the judge passed one, so its scores can't be trusted."}
          </li>
          <li className={cal.labelledItems ? (cal.rate >= 0.9 ? "is-ok" : "is-error") : "is-pending"}>
            {cal.labelledItems
              ? `Agreement with a person on ${cal.labelledItems} blind-labelled texts (${cal.n} judgements, planted bad texts included): ${Math.round(cal.rate * 100)}%. ${CRITERIA.map((c) => `${c} ${cal.per[c]?.agree}/${cal.per[c]?.n}`).join(", ")}.`
              : "Not calibrated yet: a person labels the texts blind at /evals/label (locally), then runs npm run eval -- calibrate."}
          </li>
        </ul>
        {cal.disagreements.length > 0 && (
          <ul className="checks">
            {cal.disagreements.map((d) => (
              <li key={`${d.id}-${d.criterion}`}>
                <span className="mono">{d.id}</span> · {d.criterion}: judge {d.judge ? "pass" : "fail"}, person {d.human ? "pass" : "fail"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
