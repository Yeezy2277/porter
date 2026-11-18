import type { Metadata } from "next";
import Link from "next/link";
import { model, source } from "@/config/demo";
import { AGENT_LIMITS } from "@/core/agent";
import { contentType } from "@/core/model";
import { migratable } from "@/core/source";
import { getDb } from "@/db/client";
import { getEntries, getMapping, latestRuns } from "@/db/repo";
import { getLinks } from "@/db/search";
import { serverEnv } from "@/lib/env";
import { targets } from "@/lib/link";
import { AGENT_PROMPT_VERSION } from "@/prompts/agent";
import { entryDecisionAction } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { AgentRunner } from "@/components/AgentRunner";
import { FieldEditor } from "@/components/FieldEditor";

export const metadata: Metadata = { title: "Migrate" };
export const dynamic = "force-dynamic";

const ORIGIN: Record<string, string> = { mapping: "Mapping", link: "Link", agent: "Agent", person: "Reviewer" };
const usd = (m: number) => `$${(m / 1e6).toFixed(3)}`;

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(show).join(", ");
  const id = (v as { sys?: { id?: string } } | null)?.sys?.id;
  if (id) {
    const known = targets.find((t) => t.entryId === id)?.name;
    if (known) return known;
    const fresh = /^(author|topic)-new-(.+)$/.exec(id);
    return fresh ? `New ${fresh[1]} (${id}), created by the migration` : id;
  }
  return JSON.stringify(v);
}

export default async function MigratePage({ searchParams }: { searchParams: Promise<{ post?: string }> }) {
  const db = await getDb();
  const [mapping, links, entries, runs] = await Promise.all([getMapping(db, "article"), getLinks(db), getEntries(db), latestRuns(db)]);
  const ct = contentType(model, "article");
  const posts = source.posts.filter((p) => migratable(p).ok);
  const { post: q } = await searchParams;
  const post = posts.find((p) => String(p.id) === q) ?? posts[0]!;
  const entry = entries.find((e) => e.postId === post.id);
  const lastRun = runs.find((r) => r.postId === post.id && r.status !== "running");
  const mapOk = mapping?.status === "approved";
  const linksOk = links.length > 0 && links.every((l) => l.status === "approved");
  const ready = mapOk && linksOk;
  const live = Boolean(serverEnv().live);
  const spent = runs.filter((r) => r.mode === "live").reduce((s, r) => s + r.costMicros, 0);

  return (
    <div className="wrap page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Manifest</Link> <span aria-hidden="true">/</span> <span>Stage 04 · Migrate</span>
      </nav>
      <header className="post__head">
        <p className="label">Stage 04 · a tool-using agent, then a person</p>
        <h1 className="post__title">Migrate and review</h1>
        <p className="lede">
          For each post an agent reads the source, fills the draft from the approved mapping and links, writes the few fields left to it (summary, SEO description,
          region), checks the draft and submits it. Every value it writes is checked against the field&apos;s rules and the source. It runs at most {AGENT_LIMITS.maxTurns}{" "}
          turns and {usd(AGENT_LIMITS.maxCostMicros)} per post. Nothing is approved until a person approves it.
        </p>
      </header>

      <section className="toolbar" aria-label="Preconditions">
        <div className="toolbar__state">
          <span className={`stamp ${mapOk ? "stamp--ok" : "stamp--held"}`}>Mapping {mapOk ? "approved" : "not approved"}</span>
          <span className={`stamp ${linksOk ? "stamp--ok" : "stamp--held"}`}>Links {linksOk ? "approved" : "not approved"}</span>
        </div>
        <span className="mono muted">
          prompt {AGENT_PROMPT_VERSION} · {live ? "live" : "replay"} · {entries.filter((e) => e.status === "approved").length}/{posts.length} approved · live spend {usd(spent)}
        </span>
      </section>
      {!ready && (
        <p className="action__msg action__msg--error" role="status">
          The agent works from people&apos;s decisions. {!mapOk && <Link href="/map">Approve the mapping</Link>}
          {!mapOk && !linksOk && " and "}
          {!linksOk && <Link href="/link">approve the links</Link>} first.
        </p>
      )}

      <div className="migrate">
        <nav aria-label="Posts" className="queue">
          <ul>
            {posts.map((p) => {
              const e = entries.find((x) => x.postId === p.id);
              return (
                <li key={p.id}>
                  <Link href={`/migrate?post=${p.id}`} aria-current={p.id === post.id ? "page" : undefined} className={`queue__item${p.id === post.id ? " queue__item--on" : ""}`}>
                    <span className="mono muted">{p.id}</span>
                    <span>{p.title}</span>
                    <span className={`stamp ${e?.status === "approved" ? "stamp--ok" : e ? "stamp--held" : "stamp--skip"}`}>{e ? e.status.replace("_", " ") : "not run"}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="migrate__main">
          <section className="panel" aria-labelledby="run-title">
            <h2 id="run-title" className="panel__title">
              <span>Agent · {post.title}</span>
              {lastRun && (
                <span className="mono muted">
                  last run #{lastRun.id} · {lastRun.turns} turns · {usd(lastRun.costMicros)}
                </span>
              )}
            </h2>
            <AgentRunner key={post.id} postId={post.id} ready={ready} readyReason="Approve the mapping and the links first." initial={lastRun?.events ?? []} live={live} />
          </section>

          {entry && (
            <section className="panel" aria-labelledby="entry-title">
              <h2 id="entry-title" className="panel__title">
                <span>Entry draft · {entry.entryId}</span>
                <span className={`stamp ${entry.status === "approved" ? "stamp--ok" : "stamp--held"}`}>{entry.status.replace("_", " ")}</span>
              </h2>
              {entry.notes && (
                <p className="entry__notes">
                  <strong>Agent&apos;s note:</strong> {entry.notes}
                </p>
              )}
              <dl className="entry">
                {ct.fields.map((f) => {
                  const v = entry.draft.fields[f.id];
                  const origin = entry.provenance[f.id];
                  const editable = origin?.origin === "agent" || origin?.origin === "person";
                  return (
                    <div key={f.id} className="entry__row">
                      <dt>
                        <span>{f.name}</span>
                        {origin && <span className={`origin origin--${origin.origin}`}>{ORIGIN[origin.origin]}</span>}
                      </dt>
                      <dd>
                        {v === undefined ? (
                          <span className="muted">empty</span>
                        ) : f.id === "body" ? (
                          <Link href={`/posts/${post.id}`}>Rich text, converted word for word (see the post)</Link>
                        ) : editable && typeof v === "string" ? (
                          <FieldEditor postId={post.id} field={f.id} label={f.name} value={v} seen={entry.updatedAt.toISOString()} max={f.validations.find((x) => x.size?.max)?.size?.max} />
                        ) : (
                          <span>{show(v)}</span>
                        )}
                        {origin && <span className="muted entry__why">{origin.detail}</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {entry.status !== "approved" && (
                <div className="toolbar__actions entry__actions">
                  <ActionButton action={entryDecisionAction} hidden={{ postId: String(post.id), decision: "approved", seen: entry.updatedAt.toISOString() }} label="Approve entry" pending="Approving…" disabled={entry.status === "flagged"} disabledReason={entry.status === "flagged" ? "Flagged by the agent: fix or re-run first." : undefined} />
                  <ActionButton action={entryDecisionAction} hidden={{ postId: String(post.id), decision: "rejected", seen: entry.updatedAt.toISOString() }} label="Reject" pending="Rejecting…" className="btn btn--quiet" />
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
