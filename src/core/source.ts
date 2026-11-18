import { z } from "zod";
import { decodeEntities } from "./text";

/**
 * The legacy side: a WordPress export in the wp/v2 REST shape. Parsed once at
 * the boundary into plain records, so nothing downstream knows about
 * `{ rendered }` wrappers, HTML entities in titles or WordPress date quirks.
 */

const Rendered = z.object({ rendered: z.string() });

const WpPost = z.object({
  id: z.number().int(),
  date_gmt: z.string(),
  modified_gmt: z.string(),
  slug: z.string(),
  status: z.string(),
  title: Rendered,
  excerpt: Rendered,
  content: Rendered,
  author: z.number().int(),
  categories: z.array(z.number().int()),
  tags: z.array(z.number().int()),
  featured_media: z.number().int(),
  yoast_head_json: z.object({ description: z.string().optional() }).optional(),
});

const WpExport = z.object({
  site: z.string(),
  exportedAt: z.string(),
  users: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string(), description: z.string() })),
  categories: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() })),
  tags: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() })),
  media: z.array(
    z.object({
      id: z.number().int(),
      source_url: z.url(),
      alt_text: z.string(),
      caption: Rendered,
      media_details: z.object({ width: z.number(), height: z.number() }),
    }),
  ),
  posts: z.array(WpPost),
});

export type SourceAuthor = { id: number; name: string; slug: string; bio: string };
export type SourceTerm = { id: number; name: string; slug: string; kind: "category" | "tag" };
export type SourceMedia = { id: number; url: string; alt: string; caption: string; width: number; height: number };

export type SourcePost = {
  id: number;
  slug: string;
  title: string;
  /** UTC ISO string; null when WordPress never published it. */
  publishedAt: string | null;
  modifiedAt: string | null;
  status: string;
  excerpt: string;
  html: string;
  author: SourceAuthor | null;
  terms: SourceTerm[];
  featured: SourceMedia | null;
  seoDescription: string;
};

export type SourceExport = {
  site: string;
  posts: SourcePost[];
  authors: SourceAuthor[];
  terms: SourceTerm[];
  media: SourceMedia[];
};

/**
 * WordPress writes `date_gmt` without a zone ("2019-04-12T08:30:00") and uses
 * all zeros for never-published drafts. Both are handled here, once.
 */
export function wpGmtToIso(value: string): string | null {
  if (/^0000-00-00/.test(value)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls 2019-02-31 into March; reject instead of migrating a wrong date.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString();
}

/** Strips tags from a short HTML field (titles, excerpts, captions). Bodies go through the rich-text transform instead. */
export function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseExport(input: unknown): SourceExport {
  const raw = WpExport.parse(input);
  const authors: SourceAuthor[] = raw.users.map((u) => ({ id: u.id, name: plainText(u.name), slug: u.slug, bio: plainText(u.description) }));
  const terms: SourceTerm[] = [
    ...raw.categories.map((c) => ({ id: c.id, name: plainText(c.name), slug: c.slug, kind: "category" as const })),
    ...raw.tags.map((t) => ({ id: t.id, name: plainText(t.name), slug: t.slug, kind: "tag" as const })),
  ];
  const media: SourceMedia[] = raw.media.map((m) => ({
    id: m.id,
    url: m.source_url,
    alt: plainText(m.alt_text),
    caption: plainText(m.caption.rendered),
    width: m.media_details.width,
    height: m.media_details.height,
  }));
  const termKey = (kind: SourceTerm["kind"], id: number) => terms.find((t) => t.kind === kind && t.id === id);

  const posts: SourcePost[] = raw.posts.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: plainText(p.title.rendered),
    publishedAt: wpGmtToIso(p.date_gmt),
    modifiedAt: wpGmtToIso(p.modified_gmt),
    status: p.status,
    excerpt: plainText(p.excerpt.rendered),
    html: p.content.rendered,
    author: authors.find((a) => a.id === p.author) ?? null,
    terms: [
      ...p.categories.map((id) => termKey("category", id)),
      ...p.tags.map((id) => termKey("tag", id)),
    ].filter((t): t is SourceTerm => Boolean(t)),
    featured: media.find((m) => m.id === p.featured_media) ?? null,
    seoDescription: plainText(p.yoast_head_json?.description ?? ""),
  }));

  return { site: raw.site, posts, authors, terms, media };
}

/** Only published posts migrate; drafts and trash stay behind with a reason. */
export function migratable(post: SourcePost): { ok: true } | { ok: false; reason: string } {
  if (post.status !== "publish") return { ok: false, reason: `status is "${post.status}"` };
  if (!post.publishedAt) return { ok: false, reason: "no publish date" };
  return { ok: true };
}
