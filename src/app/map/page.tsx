import type { Metadata } from "next";
import Link from "next/link";
import { model, source } from "@/config/demo";
import { contentType } from "@/core/model";
import { migratable } from "@/core/source";
import { getDb } from "@/db/client";
import { getMapping, recentCalls, spend } from "@/db/repo";
import { serverEnv } from "@/lib/env";
import { preview, problemsFor } from "@/lib/map";
import { MAP_PROMPT_VERSION } from "@/prompts/map";
import { approveAction, proposeAction, resetAction } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { MappingEditor } from "@/components/MappingEditor";

export const metadata: Metadata = { title: "Field mapping" };
export const dynamic = "force-dynamic";

const CT = "article";
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;

export default async function MapPage({ searchParams }: { searchParams: Promise<{ post?: string }> }) {
  const ct = contentType(model, CT);
  const db = await getDb();
  const [row, calls, total] = await Promise.all([getMapping(db, CT), recentCalls(db, 5), spend(db)]);
  const live = serverEnv().live;
  const problems = row ? problemsFor(row.mapping) : [];
  const errors = problems.filter((p) => p.severity === "error").length;
  const posts = source.posts.filter((p) => migratable(p).ok);
  const { post: postParam } = await searchParams;
  const chosen = posts.find((p) => String(p.id) === postParam) ?? posts[0];
  const pv = row && chosen ? preview(row.mapping, chosen) : null;
  const proposedBy = row?.proposedBy ? calls.find((c) => c.id === row.proposedBy) : undefined;

  return (
    <div className="wrap page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Manifest</Link> <span aria-hidden="true">/</span> <span>Stage 02 · Map</span>
      </nav>
      <header className="post__head">
        <p className="label">Stage 02 · structured output, human approval</p>
        <h1 className="post__title">Field mapping: {ct.name}</h1>
        <p className="lede">
          Claude reads the source fields (with real sample values) and the target type&apos;s rules, and proposes which source fills each field and with which transform.
          It can only choose from a fixed menu; code checks the proposal, you fix and approve it, and code applies it.
        </p>
      </header>

      <section className="toolbar" aria-label="Mapping actions">
        <div className="toolbar__state">
          {row ? (
            <span className={`stamp ${row.status === "approved" ? "stamp--ok" : "stamp--held"}`}>{row.status === "approved" ? "Cleared · approved" : "Held · awaiting review"}</span>
          ) : (
            <span className="stamp stamp--held">No mapping yet</span>
          )}
          <span className="mono muted">
            prompt {MAP_PROMPT_VERSION} · {live ? `live (${live.model})` : "replay mode"}
          </span>
        </div>
        <div className="toolbar__actions">
          <ActionButton
            action={proposeAction}
            hidden={{ contentType: CT }}
            label={row ? "Propose again" : live ? "Ask Claude to propose" : "Replay Claude's proposal"}
            pending={live ? "Claude is mapping…" : "Replaying…"}
            className={row ? "btn btn--quiet" : "btn"}
          />
          {row && row.status !== "approved" && (
            <ActionButton
              action={approveAction}
              hidden={{ contentType: CT, seen: row.updatedAt.toISOString() }}
              label="Approve mapping"
              pending="Approving…"
              disabled={errors > 0}
              disabledReason={errors > 0 ? `Fix ${errors} error${errors > 1 ? "s" : ""} to approve.` : undefined}
            />
          )}
          {row && <ActionButton action={resetAction} hidden={{ contentType: CT }} label="Reset" pending="Clearing…" className="btn btn--quiet" />}
        </div>
      </section>

      {!row ? (
        <div className="empty">
          <p className="label">Nothing proposed</p>
          <p>
            {live
              ? "Ask Claude for a first proposal. It costs a few cents and is logged below."
              : "No API key here, so the button replays a proposal Claude made earlier for exactly this input. The checks, the review and the preview all run for real."}
          </p>
        </div>
      ) : (
        <>
          {(row.mapping.questions.length > 0 || row.mapping.unmapped.length > 0) && (
            <section className="section notes" aria-labelledby="asks-title">
              <h2 id="asks-title" className="h3">
                Claude&apos;s questions and leftovers
              </h2>
              <ul>
                {row.mapping.questions.map((q) => (
                  <li key={q}>
                    <strong>Question:</strong> {q}
                  </li>
                ))}
                {row.mapping.unmapped.map((u) => (
                  <li key={u.source}>
                    <strong className="mono">{u.source}</strong> not used: {u.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="section" aria-labelledby="fields-title">
            <h2 id="fields-title" className="h2">
              Review
            </h2>
            <p className="muted">
              {proposedBy ? `Proposed by ${proposedBy.model} (${proposedBy.mode})` : "Written by hand"}
              {row.edited ? ` · edited ${row.edited} time${row.edited > 1 ? "s" : ""}` : ""}
              {row.approvedAt ? ` · approved ${row.approvedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
            </p>
            <MappingEditor key={row.updatedAt.toISOString()} contentType={ct} initial={row.mapping} />
          </section>

          {pv && (
            <section className="section" aria-labelledby="preview-title">
              <div className="section__head">
                <h2 id="preview-title" className="h2">
                  Dry run
                </h2>
                <nav aria-label="Preview post" className="chips">
                  {posts.map((p) => (
                    <Link key={p.id} href={`/map?post=${p.id}`} className={`chip${p.id === pv.post.id ? " chip--on" : ""}`} aria-current={p.id === pv.post.id ? "page" : undefined}>
                      {p.id}
                    </Link>
                  ))}
                </nav>
              </div>
              <p className="muted">The saved mapping applied to “{pv.post.title}”. Nothing is written anywhere.</p>
              <div className="split">
                <div className="panel">
                  <h3 className="panel__title">
                    <span>Checks</span>
                  </h3>
                  <ul className="checks">
                    {pv.problems.length === 0 ? <li className="is-ok">Every filled field passes the content type&apos;s rules.</li> : pv.problems.map((p) => <li key={p.field + p.message} className="is-error">{p.message}</li>)}
                    {pv.usedFallback.map((f) => (
                      <li key={f}>
                        <span className="mono">{f}</span>: the primary source was empty or broke the rules, so the fallback ran.
                      </li>
                    ))}
                    {pv.pending.map((p) => (
                      <li key={p.target} className="is-pending">
                        <span className="mono">{p.target}</span>: {p.transform === "generate" ? "written in stage 04" : "linked in stage 03"} from {p.sources.join(", ")}.
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="panel">
                  <h3 className="panel__title">
                    <span>Entry draft</span>
                    <span className="mono muted">{pv.draft.id}</span>
                  </h3>
                  <pre className="code" tabIndex={0} aria-label="Entry draft JSON">
                    {JSON.stringify({ ...pv.draft, fields: { ...pv.draft.fields, body: pv.draft.fields.body ? "‹rich text, see the post page›" : undefined } }, null, 2)}
                  </pre>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      <section className="section" aria-labelledby="calls-title">
        <h2 id="calls-title" className="h3">
          Model calls
        </h2>
        <p className="muted">
          {total.calls} call{total.calls === 1 ? "" : "s"} logged · live spend {usd(total.liveMicros)} (replays cost nothing)
        </p>
        {calls.length > 0 && (
          <div className="manifest" role="region" aria-label="Recent model calls" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Tokens in / out</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>
                      {c.purpose} <span className="mono muted">{c.promptVersion}</span>
                    </td>
                    <td className="mono">{c.mode}</td>
                    <td className="mono">
                      {c.inputTokens.toLocaleString("en")} / {c.outputTokens.toLocaleString("en")}
                    </td>
                    <td className="mono">{c.mode === "live" ? usd(c.costMicros) : `(${usd(c.costMicros)})`}</td>
                    <td className="mono">{(c.durationMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
