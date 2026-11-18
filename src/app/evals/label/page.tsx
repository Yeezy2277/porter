import type { Metadata } from "next";
import Link from "next/link";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import itemsJson from "../../../../evals/agent/baseline/judge-items.json";
import { CRITERIA, JUDGE_CRITERIA } from "@/evals/grade";
import { LabelForm } from "@/components/LabelForm";

export const metadata: Metadata = { title: "Label the judge's items" };
export const dynamic = "force-dynamic";

type Item = { id: string; title: string; field: string; text: string; article: string };

/** A stable shuffle (by a hash of the id), so planted and real items are mixed the same way every time. */
const order = (id: string) => [...id].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);

async function savedLabels(): Promise<Record<string, Record<string, boolean>>> {
  try {
    return (JSON.parse(await readFile(join(process.cwd(), "samples", "evals", "labels.json"), "utf8")) as { labels: Record<string, Record<string, boolean>> }).labels;
  } catch {
    return {};
  }
}

export default async function LabelPage() {
  // Blind: no judge verdicts and no "planted" marks reach this page.
  const items = (itemsJson as unknown as Item[]).map(({ id, title, field, text, article }) => ({ id, title, field, text, article })).sort((a, b) => order(a.id) - order(b.id));
  const labels = await savedLabels();
  const done = items.filter((i) => labels[i.id]).length;
  const criteria = CRITERIA.map((c) => ({ id: c, text: JUDGE_CRITERIA[c] }));
  return (
    <div className="wrap page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Manifest</Link> <span aria-hidden="true">/</span> <Link href="/evals">Evals</Link> <span aria-hidden="true">/</span> <span>Label</span>
      </nav>
      <header className="post__head">
        <p className="label">Stage 05 · calibrate the judge</p>
        <h1 className="post__title">Label {items.length} texts</h1>
        <p className="lede">
          Read each article and the text written for it, then pass or fail it on each criterion. You won&apos;t see the judge&apos;s answers; some texts were written badly on
          purpose. Your labels measure how far the judge&apos;s scores can be trusted. {done}/{items.length} labelled.
        </p>
      </header>
      <ol className="labels">
        {items.map((item, i) => (
          <li key={item.id} className="panel labelitem">
            <h2 className="panel__title">
              <span>
                {i + 1}. {item.field === "summary" ? "Summary" : "SEO description"} · {item.title}
              </span>
              {labels[item.id] && <span className="stamp stamp--ok">labelled</span>}
            </h2>
            <div className="labelitem__body">
              <blockquote className="labelitem__text">{item.text}</blockquote>
              <details>
                <summary>The article</summary>
                <p className="labelitem__article">{item.article}</p>
              </details>
              <LabelForm id={item.id} criteria={criteria} saved={labels[item.id] ?? null} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
