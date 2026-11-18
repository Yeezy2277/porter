import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SITE_ORIGIN, model, source } from "@/config/demo";
import { convertBody } from "@/core/convert";
import { migratable } from "@/core/source";
import { RichText } from "@/components/RichText";

type Props = { params: Promise<{ id: string }> };

export function generateStaticParams() {
  return source.posts.map((p) => ({ id: String(p.id) }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const post = source.posts.find((p) => String(p.id) === id);
  return { title: post?.title ?? "Not found" };
}

const WHAT: Record<string, string> = {
  "shortcode-removed": "WordPress shortcode removed: it rendered a plugin widget, not content.",
  "script-removed": "Script or style removed.",
  "iframe-dropped": "Embed dropped: not a supported video host.",
  "heading-changed": "Heading level changed to one the field allows.",
  "mark-dropped": "Formatting dropped: the field doesn't allow it.",
  "unsupported-block": "Block flattened: the field doesn't allow it.",
  "relative-link": "Relative link resolved against the old site.",
  "comment-removed": "HTML comment removed.",
};

export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const post = source.posts.find((p) => String(p.id) === id);
  if (!post) notFound();
  const gate = migratable(post);
  const conv = gate.ok ? convertBody(post, source, model, SITE_ORIGIN) : null;
  const titleOf = (entryId: string) => source.posts.find((p) => `article-${p.slug}` === entryId)?.title ?? null;

  return (
    <div className="wrap page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Manifest</Link> <span aria-hidden="true">/</span> <span className="mono">{post.id}</span>
      </nav>
      <header className="post__head">
        <p className="label">
          {post.author?.name ?? "No author"} · {post.publishedAt ? `${post.publishedAt.slice(0, 16).replace("T", " ")} UTC` : "never published"}
        </p>
        <h1 className="post__title">{post.title}</h1>
        <ul className="chips" aria-label="Terms in WordPress">
          {post.terms.map((t) => (
            <li key={`${t.kind}-${t.id}`} className="chip">
              <span className="muted">{t.kind}</span> {t.name}
            </li>
          ))}
        </ul>
      </header>

      {!conv ? (
        <div className="empty">
          <p className="label">Held</p>
          <p>This post stays behind: {gate.ok ? "" : gate.reason}. Only published posts migrate.</p>
        </div>
      ) : (
        <>
          <section className={`check ${conv.check.ok ? "check--ok" : "check--bad"}`} aria-labelledby="check-title">
            <h2 id="check-title" className="check__title">
              {conv.check.ok ? "Every word accounted for" : "The text changed"}
            </h2>
            <p>
              {conv.check.ok
                ? `The migrated body has the same words in the same order as the old page${conv.movedText.length ? `, with ${conv.movedText.length} image caption${conv.movedText.length > 1 ? "s" : ""} moved to the asset` : ""}.`
                : `Missing: ${conv.check.missing.join(" · ") || "none"}. Added: ${conv.check.added.join(" · ") || "none"}.`}
            </p>
          </section>

          {conv.warnings.length > 0 && (
            <section aria-labelledby="warn-title" className="section">
              <h2 id="warn-title" className="h3">
                Removed or changed ({conv.warnings.length})
              </h2>
              <ul className="warnings">
                {conv.warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`}>
                    {WHAT[w.code]} <code>{w.detail}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="split">
            <section aria-labelledby="out-title" className="panel">
              <h2 id="out-title" className="panel__title">
                <span>Contentful · body</span>
                <span className="mono muted">Rich Text</span>
              </h2>
              <RichText document={conv.document} assets={conv.assets} videos={conv.videos} articleTitle={titleOf} />
            </section>
            <section aria-labelledby="src-title" className="panel">
              <h2 id="src-title" className="panel__title">
                <span>WordPress · content.rendered</span>
                <span className="mono muted">HTML</span>
              </h2>
              <pre className="code" tabIndex={0} aria-label="Source HTML">
                {post.html}
              </pre>
            </section>
          </div>

          <details className="section json">
            <summary>Rich Text JSON as Contentful stores it</summary>
            <pre className="code" tabIndex={0}>
              {JSON.stringify(conv.document, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
