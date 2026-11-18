import type { Metadata } from "next";
import Link from "next/link";
import { sourceEntities, newEntryId } from "@/core/link";
import { source } from "@/config/demo";
import { getDb } from "@/db/client";
import { getLinks, indexState } from "@/db/search";
import { embedder } from "@/lib/embed";
import { targets } from "@/lib/link";
import { serverEnv } from "@/lib/env";
import { LINK_PROMPT_VERSION } from "@/prompts/link";
import { approveLinksAction, buildIndexAction, proposeLinksAction, resetLinksAction } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { LinkChoice } from "@/components/LinkChoice";

export const metadata: Metadata = { title: "Linking" };
export const dynamic = "force-dynamic";

const EMBEDDER_NOTE: Record<string, string> = {
  live: "Voyage AI, live",
  replay: "Voyage AI, recorded vectors",
  local: "local hashing stand-in (spelling, not meaning)",
};

export default async function LinkPage() {
  const db = await getDb();
  const [state, rows] = await Promise.all([indexState(db), getLinks(db)]);
  const e = embedder();
  const live = serverEnv().live;
  const sources = new Map(sourceEntities(source).map((s) => [s.key, s]));
  const nameOf = (id: string | null) => (id ? (targets.find((t) => t.entryId === id)?.name ?? id) : "");
  const flagged = rows.filter((r) => r.problems.length).length;
  const approved = rows.length > 0 && rows.every((r) => r.status === "approved");
  const stale = state.rows > 0 && state.embedder !== e.id;
  const groups = [
    { title: "Authors", rows: rows.filter((r) => r.contentType === "author") },
    { title: "Topics", rows: rows.filter((r) => r.contentType === "topic") },
  ];

  return (
    <div className="wrap page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Manifest</Link> <span aria-hidden="true">/</span> <span>Stage 03 · Link</span>
      </nav>
      <header className="post__head">
        <p className="label">Stage 03 · retrieval (RAG), rules, then Claude</p>
        <h1 className="post__title">Authors and topics</h1>
        <p className="lede">
          The new space already has {targets.filter((t) => t.contentType === "author").length} authors and {targets.filter((t) => t.contentType === "topic").length} topics. Each WordPress author and term is
          searched against them two ways, by meaning (vectors) and by words (full text), and the two rankings are fused. Same-name matches are settled by a rule;
          Claude decides the rest, choosing only among what was retrieved and quoting its evidence, and code checks both.
        </p>
      </header>

      <section className="toolbar" aria-label="Linking actions">
        <div className="toolbar__state">
          {rows.length ? (
            <span className={`stamp ${approved ? "stamp--ok" : "stamp--held"}`}>{approved ? "Cleared · approved" : flagged ? `Held · ${flagged} flagged` : "Held · awaiting review"}</span>
          ) : (
            <span className="stamp stamp--held">No decisions yet</span>
          )}
          <span className="mono muted">
            index: {state.rows ? `${state.rows} entries · ${state.embedder}` : "not built"} · embedder: {EMBEDDER_NOTE[e.mode]} · prompt {LINK_PROMPT_VERSION} · {live ? "Claude live" : "Claude replay"}
          </span>
          {stale && <span className="action__msg action__msg--error">The index was built with {state.embedder}; rebuild it so queries and entries share one vector space.</span>}
        </div>
        <div className="toolbar__actions">
          <ActionButton action={buildIndexAction} label={state.rows ? "Rebuild index" : "1. Build the index"} pending="Embedding…" className={state.rows ? "btn btn--quiet" : "btn"} />
          <ActionButton action={proposeLinksAction} label={rows.length ? "Propose again" : "2. Retrieve and decide"} pending="Searching and deciding…" className={rows.length ? "btn btn--quiet" : "btn"} disabled={!state.rows || stale} disabledReason={!state.rows ? "Build the index first." : undefined} />
          {rows.length > 0 && !approved && (
            <ActionButton action={approveLinksAction} label="Approve decisions" pending="Approving…" disabled={flagged > 0} disabledReason={flagged ? `Decide the ${flagged} flagged item${flagged > 1 ? "s" : ""} first.` : undefined} />
          )}
          {rows.length > 0 && <ActionButton action={resetLinksAction} label="Reset" pending="Clearing…" className="btn btn--quiet" />}
        </div>
      </section>

      {!rows.length ? (
        <div className="empty">
          <p className="label">How it runs</p>
          <ol className="steps">
            <li>Embed every existing author and topic and store the vectors in Postgres (pgvector, HNSW index).</li>
            <li>For each WordPress author and term: nearest neighbours by cosine similarity, full-text matches (English stemming), fused with Reciprocal Rank Fusion.</li>
            <li>Rules settle same-name matches and WordPress&apos;s default category. The rest goes to Claude with its candidates, one call per content type.</li>
            <li>Code checks every answer: the entry was retrieved for that item, the quoted evidence exists, tags never create topics. Problems wait for you.</li>
          </ol>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.title} className="section" aria-labelledby={`g-${g.title}`}>
            <h2 id={`g-${g.title}`} className="h2">
              {g.title}
            </h2>
            <ul className="links">
              {g.rows.map((r) => {
                const s = sources.get(r.sourceKey);
                const label = s?.name ?? r.sourceKey;
                const current = r.decision === "link" ? `link:${r.entryId}` : r.decision;
                const options = [
                  ...r.candidates.map((c) => ({ value: `link:${c.entryId}`, label: `Link → ${c.name}` })),
                  ...(r.sourceKey.startsWith("tag:") ? [] : [{ value: "new", label: `New ${r.contentType} (${newEntryId(r.contentType, s?.slug ?? "")})` }]),
                  { value: "skip", label: "Skip" },
                ];
                return (
                  <li key={r.sourceKey} className={`linkrow${r.problems.length ? " linkrow--flag" : ""}`}>
                    <div className="linkrow__src">
                      <span className="mono muted">
                        {s?.kind ?? r.sourceKey.split(":")[0]} · {s?.posts ?? 0} post{s?.posts === 1 ? "" : "s"}
                      </span>
                      <strong>{label}</strong>
                      {s && s.kind === "author" && s.text.includes(". ") && <span className="muted">{s.text.split(". ").slice(1).join(". ")}</span>}
                    </div>
                    <div className="linkrow__cands" aria-label={`Candidates for ${label}`}>
                      {r.candidates.length === 0 ? (
                        <span className="muted">Nothing retrieved.</span>
                      ) : (
                        <ol>
                          {r.candidates.map((c) => (
                            <li key={c.entryId} className={c.entryId === r.entryId ? "is-chosen" : undefined}>
                              <span>{c.name}</span>
                              <span className="mono muted">
                                cos {c.similarity ?? "–"} · kw #{c.keywordRank ?? "–"}
                              </span>
                              <span className="bar" aria-hidden="true" style={{ width: `${Math.round((c.fused / (2 / 61)) * 100)}%` }} />
                            </li>
                          ))}
                        </ol>
                      )}
                      {!r.vectorUsed && <span className="muted">No vector for this query in the recorded space; keywords only.</span>}
                    </div>
                    <div className="linkrow__decision">
                      <span className={`stamp ${r.decision === "link" ? "stamp--ok" : r.decision === "new" ? "stamp--new" : "stamp--skip"}`}>
                        {r.decision === "link" ? `Link · ${nameOf(r.entryId)}` : r.decision === "new" ? "New entry" : "Skip"}
                      </span>
                      <span className="mono muted">by {r.decidedBy}</span>
                      {r.reason && <span>{r.reason}</span>}
                      {r.evidence && r.decidedBy !== "person" && <q className="muted">{r.evidence}</q>}
                      {r.problems.length > 0 && (
                        <ul className="maprow__problems" aria-label="Problems found by code">
                          {r.problems.map((p) => (
                            <li key={p} className="is-error">
                              {p}
                            </li>
                          ))}
                        </ul>
                      )}
                      <LinkChoice source={r.sourceKey} label={label} current={current} options={options} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
