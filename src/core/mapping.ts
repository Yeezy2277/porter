import { z } from "zod";
import { validateField, type ContentType, type EntryDraft, type Field, type FieldValue, type Link, type Resolver } from "./model";
import type { SourcePost } from "./source";
import { slugify, stableId } from "./text";

/**
 * Field mapping: which source field fills which target field, and how.
 *
 * The model proposes a mapping, but it can only pick from two closed menus:
 * the source fields below and the transforms below. It never writes code or
 * values. Code checks the proposal (types, required fields), a person
 * approves it, and code applies it. That keeps the LLM's job small enough
 * to check.
 */

export type SourceKind = "text" | "html" | "date" | "author" | "terms" | "media";

export type SourceField = { id: string; label: string; kind: SourceKind; read: (p: SourcePost) => unknown };

export const SOURCE_FIELDS = [
  { id: "post.title", label: "Title", kind: "text", read: (p) => p.title },
  { id: "post.slug", label: "Slug", kind: "text", read: (p) => p.slug },
  { id: "post.date_gmt", label: "Publish date (GMT)", kind: "date", read: (p) => p.publishedAt },
  { id: "post.modified_gmt", label: "Last modified (GMT)", kind: "date", read: (p) => p.modifiedAt },
  { id: "post.excerpt", label: "Excerpt", kind: "text", read: (p) => p.excerpt },
  { id: "post.content", label: "Content (HTML)", kind: "html", read: (p) => p.html },
  { id: "post.author", label: "Author", kind: "author", read: (p) => p.author },
  { id: "post.categories", label: "Categories", kind: "terms", read: (p) => p.terms.filter((t) => t.kind === "category") },
  { id: "post.tags", label: "Tags", kind: "terms", read: (p) => p.terms.filter((t) => t.kind === "tag") },
  { id: "post.featured_media", label: "Featured image", kind: "media", read: (p) => p.featured },
  { id: "post.yoast_description", label: "Yoast SEO description", kind: "text", read: (p) => p.seoDescription },
] as const satisfies readonly SourceField[];

export type SourceFieldId = (typeof SOURCE_FIELDS)[number]["id"];
export const SOURCE_IDS = SOURCE_FIELDS.map((f) => f.id) as [SourceFieldId, ...SourceFieldId[]];

type TargetShape = "Symbol" | "Text" | "RichText" | "Date" | "EntryLink" | "EntryLinks" | "AssetLink";

/** What each transform takes and what it can fill. `generate` is written by the agent in stage 04. */
export const TRANSFORMS = {
  copy: { accepts: ["text"], fills: ["Symbol", "Text"], what: "Copy the text as it is" },
  slugify: { accepts: ["text"], fills: ["Symbol"], what: "Lowercase, accents removed, words joined by hyphens" },
  utcDate: { accepts: ["date"], fills: ["Date"], what: "ISO date in UTC" },
  richText: { accepts: ["html"], fills: ["RichText"], what: "HTML to Rich Text, word-for-word (stage 01)" },
  plainText: { accepts: ["html"], fills: ["Symbol", "Text"], what: "HTML to plain text" },
  linkAuthor: { accepts: ["author"], fills: ["EntryLink"], what: "Link to the matching author entry (stage 03)" },
  linkTopics: { accepts: ["terms"], fills: ["EntryLinks"], what: "Links to matching topic entries (stage 03)" },
  linkAsset: { accepts: ["media"], fills: ["AssetLink"], what: "Link to the image, uploaded as an asset" },
  generate: { accepts: ["text", "html"], fills: ["Symbol", "Text"], what: "Written from the sources by the agent, checked against them (stage 04)" },
  none: { accepts: [], fills: ["Symbol", "Text", "RichText", "Date", "EntryLink", "EntryLinks", "AssetLink"], what: "Leave empty" },
} as const satisfies Record<string, { accepts: readonly SourceKind[]; fills: readonly TargetShape[]; what: string }>;

export type TransformId = keyof typeof TRANSFORMS;
export const TRANSFORM_IDS = Object.keys(TRANSFORMS) as [TransformId, ...TransformId[]];

export const FieldMapping = z.object({
  target: z.string(),
  sources: z.array(z.enum(SOURCE_IDS)),
  transform: z.enum(TRANSFORM_IDS),
  /** Used when the primary sources are empty for a post (an empty excerpt, say). */
  fallback: z.object({ sources: z.array(z.enum(SOURCE_IDS)), transform: z.enum(TRANSFORM_IDS) }).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  note: z.string(),
});
export type FieldMapping = z.infer<typeof FieldMapping>;

export const Mapping = z.object({
  contentType: z.string(),
  fields: z.array(FieldMapping),
  /** Source fields deliberately left behind, and why. */
  unmapped: z.array(z.object({ source: z.enum(SOURCE_IDS), reason: z.string() })),
  /** Things a person should decide; the model asks instead of guessing. */
  questions: z.array(z.string()),
});
export type Mapping = z.infer<typeof Mapping>;

export function targetShape(field: Field): TargetShape | null {
  if (field.type === "Symbol" || field.type === "Text" || field.type === "RichText" || field.type === "Date") return field.type;
  if (field.type === "Link") return field.linkType === "Asset" ? "AssetLink" : "EntryLink";
  if (field.type === "Array" && field.items?.type === "Link" && field.items.linkType === "Entry") return "EntryLinks";
  return null;
}

const sourceKind = (id: SourceFieldId): SourceKind => (SOURCE_FIELDS.find((f) => f.id === id) as SourceField).kind;

export type MappingProblem = { target: string; severity: "error" | "warning"; message: string };

/** Code's check of a proposed (or edited) mapping, before anyone can approve it. */
export function checkMapping(mapping: Mapping, ct: ContentType): MappingProblem[] {
  const out: MappingProblem[] = [];
  if (mapping.contentType !== ct.sys.id) out.push({ target: "*", severity: "error", message: `Mapping is for "${mapping.contentType}", not "${ct.sys.id}"` });
  const seen = new Map<string, number>();
  for (const m of mapping.fields) seen.set(m.target, (seen.get(m.target) ?? 0) + 1);
  for (const [target, n] of seen) {
    if (!ct.fields.some((f) => f.id === target)) out.push({ target, severity: "error", message: `${ct.name} has no field "${target}"` });
    if (n > 1) out.push({ target, severity: "error", message: `"${target}" is mapped ${n} times` });
  }
  for (const field of ct.fields) {
    const m = mapping.fields.find((x) => x.target === field.id);
    if (!m || m.transform === "none") {
      if (field.required) out.push({ target: field.id, severity: "error", message: `${field.name} is required but not mapped` });
      continue;
    }
    out.push(...stepProblems(field, m.sources, m.transform, "Mapping"));
    if (m.fallback) out.push(...stepProblems(field, m.fallback.sources, m.fallback.transform, "Fallback"));
    if (m.transform === "generate" && field.type === "Symbol" && !field.validations.some((v) => v.size?.max || v.in)) {
      out.push({ target: field.id, severity: "warning", message: `${field.name} is generated without a length limit` });
    }
  }
  return out;
}

function stepProblems(field: Field, sources: readonly SourceFieldId[], transform: TransformId, what: string): MappingProblem[] {
  const out: MappingProblem[] = [];
  const t = TRANSFORMS[transform];
  const shape = targetShape(field);
  if (!shape || !(t.fills as readonly string[]).includes(shape)) out.push({ target: field.id, severity: "error", message: `${what}: "${transform}" can't fill a ${shape ?? field.type} field` });
  if (transform !== "none" && sources.length === 0) out.push({ target: field.id, severity: "error", message: `${what}: "${transform}" needs at least one source field` });
  for (const s of sources) {
    if (!(t.accepts as readonly string[]).includes(sourceKind(s))) out.push({ target: field.id, severity: "error", message: `${what}: "${transform}" can't read ${s} (${sourceKind(s)})` });
  }
  if (transform !== "generate" && transform !== "linkTopics" && sources.length > 1) out.push({ target: field.id, severity: "error", message: `${what}: "${transform}" takes one source field` });
  return out;
}

/** Values the mapping can't produce on its own yet; later stages fill them. */
export type Pending = { target: string; transform: "linkAuthor" | "linkTopics" | "generate"; sources: SourceFieldId[] };

export type ApplyContext = {
  richText: (post: SourcePost) => FieldValue;
  plainText: (html: string) => string;
  /** Link resolution comes from stage 03; until then these return null and the field is pending. */
  linkAuthor?: (post: SourcePost) => Link | null;
  linkTopics?: (post: SourcePost, sources: SourceFieldId[]) => Link[] | null;
  /** For checking a primary value against the field's rules (links are checked later, on the whole draft). */
  resolve: Resolver;
};

/**
 * Applies an approved mapping to one post. The fallback runs when the primary
 * value is empty *or* breaks the field's rules (an excerpt shorter than the
 * summary's minimum, say), so a valid source is always preferred over
 * generated text. Deterministic: same post and mapping, same draft.
 */
export function applyMapping(mapping: Mapping, ct: ContentType, post: SourcePost, ctx: ApplyContext): { draft: EntryDraft; pending: Pending[]; usedFallback: string[] } {
  const fields: EntryDraft["fields"] = {};
  const pending: Pending[] = [];
  const usedFallback: string[] = [];
  for (const m of mapping.fields) {
    const field = ct.fields.find((f) => f.id === m.target);
    if (!field || m.transform === "none") continue;
    let value = run(m.transform, m.sources, post, ctx);
    let used: { transform: TransformId; sources: SourceFieldId[] } = { transform: m.transform, sources: m.sources };
    const unusable = isEmpty(value) || (value !== PENDING && validateField(field, value as Exclude<FieldValue, null | undefined>, ctx.resolve).length > 0);
    if (unusable && m.fallback) {
      value = run(m.fallback.transform, m.fallback.sources, post, ctx);
      used = m.fallback;
      usedFallback.push(m.target);
    }
    if (value === PENDING) pending.push({ target: m.target, transform: used.transform as Pending["transform"], sources: [...used.sources] });
    else if (!isEmpty(value)) fields[m.target] = value as FieldValue;
  }
  const slug = typeof fields.slug === "string" ? fields.slug : slugify(post.title);
  return { draft: { contentType: mapping.contentType, id: `${mapping.contentType}-${slug}`.slice(0, 64), fields }, pending, usedFallback };
}

const PENDING = Symbol("pending");

function run(transform: TransformId, sources: readonly SourceFieldId[], post: SourcePost, ctx: ApplyContext): FieldValue | typeof PENDING {
  const first = sources[0] ? (SOURCE_FIELDS.find((f) => f.id === sources[0]) as SourceField).read(post) : undefined;
  switch (transform) {
    case "copy":
      return typeof first === "string" ? first.trim() : null;
    case "slugify":
      return typeof first === "string" ? slugify(first) : null;
    case "utcDate":
      return typeof first === "string" ? first : null;
    case "richText":
      return ctx.richText(post);
    case "plainText":
      return typeof first === "string" ? ctx.plainText(first) : null;
    case "linkAsset": {
      const media = first as SourcePost["featured"];
      return media ? { sys: { type: "Link", linkType: "Asset", id: stableId("asset", media.url) } } : null;
    }
    case "linkAuthor":
      return ctx.linkAuthor ? ctx.linkAuthor(post) ?? PENDING : PENDING;
    case "linkTopics":
      return ctx.linkTopics ? ctx.linkTopics(post, [...sources]) ?? PENDING : PENDING;
    case "generate":
      return PENDING;
    case "none":
      return null;
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** The context the model gets: every source field with real sample values, and every target field with its rules. */
export function describeForPrompt(posts: readonly SourcePost[], ct: ContentType): { sources: string; target: string; transforms: string } {
  const sample = (f: SourceField) =>
    posts
      .slice(0, 3)
      .map((p) => {
        const v = f.read(p);
        const text = typeof v === "string" ? v : v === null ? "null" : JSON.stringify(v);
        return JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text);
      })
      .join(" | ");
  const sources = (SOURCE_FIELDS as readonly SourceField[]).map((f) => `- ${f.id} (${f.kind}): ${f.label}. Samples: ${sample(f)}`).join("\n");
  const target = ct.fields
    .map((f) => {
      const rules = f.validations
        .map((v) => (v.size ? `size ${v.size.min ?? 0}..${v.size.max ?? "∞"}` : v.regexp ? `pattern ${v.regexp.pattern}` : v.in ? `one of ${v.in.join("/")}` : v.linkContentType ? `links ${v.linkContentType.join("/")}` : v.unique ? "unique" : null))
        .filter(Boolean);
      const itemRules = f.items?.validations.flatMap((v) => (v.linkContentType ? [`links ${v.linkContentType.join("/")}`] : [])) ?? [];
      return `- ${f.id} (${targetShape(f) ?? f.type}${f.required ? ", required" : ""}): ${f.name}${[...rules, ...itemRules].length ? `. Rules: ${[...rules, ...itemRules].join("; ")}` : ""}`;
    })
    .join("\n");
  const transforms = (Object.entries(TRANSFORMS) as [TransformId, (typeof TRANSFORMS)[TransformId]][])
    .map(([id, t]) => `- ${id}: ${t.what}. Reads: ${t.accepts.join(", ") || "nothing"}. Fills: ${t.fills.join(", ")}`)
    .join("\n");
  return { sources, target, transforms };
}
