import Link from "next/link";
import { SITE_ORIGIN, model, source } from "@/config/demo";
import { convertBody } from "@/core/convert";
import { migratable } from "@/core/source";

const STAGES = [
  { n: "01", name: "Convert", what: "HTML to Rich Text in code, with a word-for-word check", built: true, href: "/posts/1201" },
  { n: "02", name: "Map", what: "Claude proposes field mappings; you approve them", built: true, href: "/map" },
  { n: "03", name: "Link", what: "Authors and topics matched to existing entries (RAG)", built: true, href: "/link" },
  { n: "04", name: "Migrate", what: "An agent assembles each entry with tools; you review", built: false },
  { n: "05", name: "Measure", what: "Evals on a golden set, per prompt version", built: false },
];

const fmt = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export default function Home() {
  const rows = source.posts.map((post) => {
    const gate = migratable(post);
    const conv = gate.ok ? convertBody(post, source, model, SITE_ORIGIN) : null;
    return { post, gate, conv };
  });
  const ready = rows.filter((r) => r.conv?.check.ok).length;

  return (
    <div className="wrap page">
      <section className="hero" aria-labelledby="hero-title">
        <p className="label">Content migration · {source.site}</p>
        <h1 id="hero-title" className="hero__title">
          Carry a legacy CMS into Contentful <span>without losing a word.</span>
        </h1>
        <p className="hero__lede">
          Code converts every article body and proves the text survived. Claude only does the parts that need judgement: mapping fields, matching authors and
          topics, writing the summaries the new model requires. Nothing is published until a person approves it.
        </p>
      </section>

      <section aria-labelledby="stages-title" className="section">
        <h2 id="stages-title" className="h2">
          Route
        </h2>
        <ol className="stages">
          {STAGES.map((s) => (
            <li key={s.n} className={`stage${s.built ? " stage--built" : ""}`}>
              <span className="stage__n" aria-hidden="true">
                {s.n}
              </span>
              <span className="stage__name">
                {"href" in s && s.href ? (
                  <Link className="stage__link" href={s.href}>
                    {s.name}
                  </Link>
                ) : (
                  s.name
                )}
              </span>
              <span className="stage__what">{s.what}</span>
              <span className="stage__state mono">{s.built ? "Built" : "Next"}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="manifest-title" className="section">
        <div className="section__head">
          <h2 id="manifest-title" className="h2">
            Manifest
          </h2>
          <p className="muted">
            {source.posts.length} posts in the export · {ready} converted with every word accounted for
          </p>
        </div>
        <div className="manifest" role="region" aria-label="Posts in the export" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">No.</th>
                <th scope="col">Post</th>
                <th scope="col">Published (UTC)</th>
                <th scope="col">Warnings</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ post, gate, conv }) => (
                <tr key={post.id}>
                  <td className="mono">{post.id}</td>
                  <td>
                    <Link href={`/posts/${post.id}`} className="manifest__title">
                      {post.title}
                    </Link>
                    <span className="muted manifest__by">{post.author?.name ?? "No author"}</span>
                  </td>
                  <td className="mono">{fmt(post.publishedAt)}</td>
                  <td className="mono">{conv ? conv.warnings.length : "—"}</td>
                  <td>
                    {!gate.ok ? (
                      <span className="stamp stamp--held" title={gate.reason}>
                        Held: {gate.reason}
                      </span>
                    ) : conv?.check.ok ? (
                      <span className="stamp stamp--ok">Body cleared</span>
                    ) : (
                      <span className="stamp stamp--held">Text differs</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
