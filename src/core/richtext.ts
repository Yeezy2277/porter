import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { BLOCKS, INLINES, type Document } from "@contentful/rich-text-types";
import { slugify } from "./text";

/**
 * HTML body → Contentful Rich Text, deterministically.
 *
 * The model never writes or rewrites article text: bodies go through this
 * transform, so the words that reach Contentful are the words that left
 * WordPress. Anything the transform can't carry (scripts, unknown embeds,
 * shortcodes) is dropped *with a warning*, never silently, and the checks in
 * `grounding.ts` prove the text survived.
 */

export type Mark = "bold" | "italic" | "underline" | "code";

export type TextNode = { nodeType: "text"; value: string; marks: { type: Mark }[]; data: Record<string, never> };
type Link = { sys: { type: "Link"; linkType: "Entry" | "Asset"; id: string } };
export type InlineNode =
  | TextNode
  | { nodeType: "hyperlink"; data: { uri: string }; content: TextNode[] }
  | { nodeType: "entry-hyperlink"; data: { target: Link }; content: TextNode[] };
export type BlockNode = { nodeType: string; data: Record<string, unknown>; content: (BlockNode | InlineNode)[] };

export type WarningCode =
  | "shortcode-removed"
  | "script-removed"
  | "iframe-dropped"
  | "heading-changed"
  | "mark-dropped"
  | "unsupported-block"
  | "relative-link"
  | "comment-removed";
export type Warning = { code: WarningCode; detail: string };

export type AssetRef = { id: string; url: string; alt: string; caption: string };
export type VideoRef = { id: string; url: string; title: string };

export type TransformOptions = {
  /** The site's own origin, for telling internal links from external ones. */
  siteOrigin: string;
  /** Slugs of posts in this export: internal links to them become entry links. */
  knownSlugs: ReadonlySet<string>;
  /** Node types and marks the target field allows (from the content model's validations). */
  enabledNodeTypes: ReadonlySet<string>;
  enabledMarks: ReadonlySet<Mark>;
};

export type TransformResult = {
  document: Document;
  warnings: Warning[];
  assets: AssetRef[];
  videos: VideoRef[];
  /** Slugs of other articles this body links to. */
  entryLinks: string[];
  /** Source text deliberately kept outside the body (image captions → asset descriptions). */
  movedText: string[];
};

const DROP = new Set(["script", "style", "noscript", "form", "input", "button", "select", "textarea", "svg", "template", "head"]);
const MARK_OF: Record<string, Mark> = { strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline", code: "code", kbd: "code", tt: "code" };
const HEADINGS = [BLOCKS.HEADING_1, BLOCKS.HEADING_2, BLOCKS.HEADING_3, BLOCKS.HEADING_4, BLOCKS.HEADING_5, BLOCKS.HEADING_6] as string[];

/** Stable Contentful-safe id ([a-zA-Z0-9-_.], ≤64) for an asset or embed, so re-running a migration updates instead of duplicating. */
export function stableId(prefix: string, key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  const hash = (h >>> 0).toString(36);
  return `${prefix}-${slugify(key.split("/").pop() ?? key).slice(0, 40)}-${hash}`.slice(0, 64);
}

/**
 * WordPress shortcodes aren't HTML. [caption] wraps a real image and its
 * caption, so it becomes a <figure>; [embed] becomes an iframe; every other
 * shortcode is a plugin's runtime widget with no content to migrate.
 */
export function expandShortcodes(html: string, warnings: Warning[]): string {
  return html
    .replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, (_, inner: string) => {
      const img = /<img[^>]*>/.exec(inner)?.[0] ?? "";
      const caption = inner.replace(/<img[^>]*>/, "").trim();
      return `<figure>${img}<figcaption>${caption}</figcaption></figure>`;
    })
    .replace(/\[embed\]([\s\S]*?)\[\/embed\]/g, (_, url: string) => `<iframe src="${url.trim()}"></iframe>`)
    .replace(/\[\/?([a-z_][\w-]*)[^\]]*\]/gi, (whole: string, name: string) => {
      warnings.push({ code: "shortcode-removed", detail: whole.length > 60 ? `[${name} …]` : whole });
      return "";
    });
}

function text(value: string, marks: readonly Mark[]): TextNode {
  return { nodeType: "text", value, marks: marks.map((type) => ({ type })), data: {} };
}

const isText = (n: BlockNode | InlineNode): n is TextNode => n.nodeType === "text";
const isInline = (n: BlockNode | InlineNode): n is InlineNode => n.nodeType === "text" || n.nodeType === "hyperlink" || n.nodeType === "entry-hyperlink";

/** A paragraph break inside inline flow (from <br><br>), distinct from a single <br> newline. */
const BREAK = { nodeType: "__break", data: {}, content: [] } satisfies BlockNode;

export function htmlToRichText(html: string, opts: TransformOptions): TransformResult {
  const warnings: Warning[] = [];
  const assets: AssetRef[] = [];
  const videos: VideoRef[] = [];
  const entryLinks = new Set<string>();
  const movedText: string[] = [];
  const dom = parseDocument(expandShortcodes(html, warnings), { decodeEntities: true });

  const allowed = (type: string) => opts.enabledNodeTypes.has(type);

  function heading(level: number): string | null {
    // Clamp to the nearest heading the model allows: an h1 inside a body
    // usually means "section title", and the page owns the real h1.
    const wanted = HEADINGS[level - 1] as string;
    const order = [wanted, ...HEADINGS.slice(level), ...HEADINGS.slice(0, level - 1).reverse()];
    const pick = order.find(allowed) ?? null;
    if (pick !== wanted) warnings.push({ code: "heading-changed", detail: pick ? `h${level} → ${pick}` : `h${level} → paragraph` });
    return pick;
  }

  function linkTarget(href: string): { kind: "entry"; slug: string } | { kind: "url"; uri: string } | null {
    let url: URL;
    try {
      url = new URL(href, opts.siteOrigin);
    } catch {
      return null;
    }
    if (url.origin === new URL(opts.siteOrigin).origin) {
      const slug = url.pathname.split("/").filter(Boolean).pop() ?? "";
      if (opts.knownSlugs.has(slug) && allowed(INLINES.ENTRY_HYPERLINK)) return { kind: "entry", slug };
      if (!/^https?:/i.test(href)) warnings.push({ code: "relative-link", detail: `${href} → ${url.href}` });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
    return { kind: "url", uri: url.href };
  }

  function asset(el: Element, caption: string): BlockNode | null {
    const src = el.attribs.src;
    if (!src) return null;
    const ref: AssetRef = { id: stableId("asset", src), url: src, alt: el.attribs.alt ?? "", caption };
    if (!assets.some((a) => a.id === ref.id)) assets.push(ref);
    if (caption) movedText.push(caption);
    if (!allowed(BLOCKS.EMBEDDED_ASSET)) {
      warnings.push({ code: "unsupported-block", detail: `image ${src} (embedded assets not enabled)` });
      return null;
    }
    return { nodeType: BLOCKS.EMBEDDED_ASSET, data: { target: { sys: { type: "Link", linkType: "Asset", id: ref.id } } }, content: [] };
  }

  function video(el: Element): BlockNode | null {
    const src = el.attribs.src ?? "";
    const m = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})|player\.vimeo\.com\/video\/(\d+)/.exec(src);
    if (!m || !allowed(BLOCKS.EMBEDDED_ENTRY)) {
      warnings.push({ code: "iframe-dropped", detail: src || "iframe without src" });
      return null;
    }
    const url = m[1] ? `https://www.youtube.com/embed/${m[1]}` : `https://player.vimeo.com/video/${m[2]}`;
    const ref: VideoRef = { id: stableId("video", url), url, title: el.attribs.title?.trim() || "Video" };
    if (!videos.some((v) => v.id === ref.id)) videos.push(ref);
    return { nodeType: BLOCKS.EMBEDDED_ENTRY, data: { target: { sys: { type: "Link", linkType: "Entry", id: ref.id } } }, content: [] };
  }

  /** Walks children into a mixed sequence of inline nodes and blocks; `group` turns it into blocks. */
  function flow(nodes: ChildNode[], marks: readonly Mark[]): (BlockNode | InlineNode)[] {
    const out: (BlockNode | InlineNode)[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as ChildNode;
      if (node.type === "text") {
        out.push(text((node as unknown as { data: string }).data, marks));
        continue;
      }
      if (node.type === "comment") {
        warnings.push({ code: "comment-removed", detail: (node as unknown as { data: string }).data.trim().slice(0, 60) });
        continue;
      }
      if (node.type === "script" || node.type === "style") {
        warnings.push({ code: "script-removed", detail: `<${(node as Element).name}>` });
        continue;
      }
      if (node.type !== "tag") continue;
      const el = node as Element;
      const name = el.name.toLowerCase();

      if (DROP.has(name)) {
        warnings.push({ code: "script-removed", detail: `<${name}>` });
        continue;
      }
      if (name === "br") {
        const next = nextTag(nodes, i);
        if (next && next.name === "br") {
          out.push(BREAK);
          i = nodes.indexOf(next);
        } else out.push(text("\n", marks));
        continue;
      }
      if (MARK_OF[name]) {
        const mark = MARK_OF[name];
        const enabled = opts.enabledMarks.has(mark);
        if (!enabled) warnings.push({ code: "mark-dropped", detail: `<${name}> (${mark} not enabled)` });
        out.push(...flow(el.children, enabled && !marks.includes(mark) ? [...marks, mark] : marks));
        continue;
      }
      if (name === "a") {
        const inner = inlineText(flow(el.children, marks));
        const target = el.attribs.href ? linkTarget(el.attribs.href) : null;
        if (!target || !inner.length) out.push(...inner);
        else if (target.kind === "entry") {
          entryLinks.add(target.slug);
          out.push({ nodeType: "entry-hyperlink", data: { target: { sys: { type: "Link", linkType: "Entry", id: `article-${target.slug}`.slice(0, 64) } } }, content: inner });
        } else if (allowed(INLINES.HYPERLINK)) out.push({ nodeType: "hyperlink", data: { uri: target.uri }, content: inner });
        else out.push(...inner);
        continue;
      }
      if (name === "img") {
        const block = asset(el, "");
        if (block) out.push(block);
        continue;
      }
      if (name === "iframe" || name === "embed" || name === "object" || name === "video") {
        const block = name === "iframe" ? video(el) : null;
        if (block) out.push(block);
        else if (name !== "iframe") warnings.push({ code: "iframe-dropped", detail: `<${name}>` });
        continue;
      }
      if (name === "figure") {
        const img = findTag(el, "img");
        const iframe = findTag(el, "iframe");
        const caption = findTag(el, "figcaption");
        const captionText = caption ? collapse(inlineText(flow(caption.children, [])).map((t) => t.value).join("")) : "";
        if (img) {
          const block = asset(img, captionText);
          if (block) out.push(block);
        } else if (iframe) {
          const block = video(iframe);
          if (block) out.push(block);
          if (captionText) out.push(...flow(caption?.children ?? [], marks));
        } else out.push(...flow(el.children, marks));
        continue;
      }
      if (name === "p") {
        out.push(BREAK, ...flow(el.children, marks), BREAK);
        continue;
      }
      if (/^h[1-6]$/.test(name)) {
        const type = heading(Number(name[1]));
        const inner = inlines(flow(el.children, marks));
        if (type) out.push(BREAK, { nodeType: type, data: {}, content: inner.length ? inner : [text("", [])] }, BREAK);
        else out.push(BREAK, ...inner, BREAK);
        continue;
      }
      if (name === "ul" || name === "ol") {
        const type = name === "ul" ? BLOCKS.UL_LIST : BLOCKS.OL_LIST;
        const items = el.children.filter((c): c is Element => c.type === "tag" && (c as Element).name === "li").map((li) => listItem(li, marks));
        if (!allowed(type)) {
          warnings.push({ code: "unsupported-block", detail: `${type} → paragraphs` });
          for (const item of items) out.push(BREAK, ...item.content.flatMap((b) => (isInline(b) ? [b] : (b as BlockNode).content)), BREAK);
        } else if (items.length) out.push({ nodeType: type, data: {}, content: items });
        continue;
      }
      if (name === "blockquote") {
        const paras = group(flow(el.children, marks)).flatMap((b) => (b.nodeType === BLOCKS.PARAGRAPH ? [b] : asParagraphs(b)));
        if (allowed(BLOCKS.QUOTE) && paras.length) out.push({ nodeType: BLOCKS.QUOTE, data: {}, content: paras });
        else out.push(...paras);
        continue;
      }
      if (name === "hr") {
        if (allowed(BLOCKS.HR)) out.push({ nodeType: BLOCKS.HR, data: {}, content: [] });
        continue;
      }
      if (name === "table") {
        const block = table(el, marks);
        if (block) out.push(block);
        continue;
      }
      // Wrappers (div, section, span, figure groups…): keep the content, lose the wrapper.
      out.push(...flow(el.children, marks));
    }
    return out;
  }

  function listItem(li: Element, marks: readonly Mark[]): BlockNode {
    const blocks = group(flow(li.children, marks)).flatMap((b) =>
      b.nodeType === BLOCKS.PARAGRAPH || b.nodeType === BLOCKS.UL_LIST || b.nodeType === BLOCKS.OL_LIST ? [b] : asParagraphs(b),
    );
    return { nodeType: BLOCKS.LIST_ITEM, data: {}, content: blocks.length ? blocks : [paragraph([text("", [])])] };
  }

  function table(el: Element, marks: readonly Mark[]): BlockNode | null {
    const rows = allTags(el, "tr").map((tr) => {
      const cells = tr.children.filter((c): c is Element => c.type === "tag" && ((c as Element).name === "td" || (c as Element).name === "th"));
      return cells.map((cell) => {
        const paras = group(flow(cell.children, marks)).flatMap((b) => (b.nodeType === BLOCKS.PARAGRAPH ? [b] : asParagraphs(b)));
        return { nodeType: cell.name === "th" ? BLOCKS.TABLE_HEADER_CELL : BLOCKS.TABLE_CELL, data: {}, content: paras.length ? paras : [paragraph([text("", [])])] };
      });
    });
    if (!rows.length) return null;
    if (!allowed(BLOCKS.TABLE)) {
      warnings.push({ code: "unsupported-block", detail: "table → paragraphs" });
      return null;
    }
    return { nodeType: BLOCKS.TABLE, data: {}, content: rows.map((cells) => ({ nodeType: BLOCKS.TABLE_ROW, data: {}, content: cells })) };
  }

  const document: Document = {
    nodeType: BLOCKS.DOCUMENT,
    data: {},
    content: group(flow(dom.children, [])) as unknown as Document["content"],
  };
  return { document, warnings, assets, videos, entryLinks: [...entryLinks], movedText };
}

function paragraph(content: InlineNode[]): BlockNode {
  return { nodeType: BLOCKS.PARAGRAPH, data: {}, content };
}

/** Text nodes only, from a flow (used where the target allows nothing else: link text, captions). */
function inlineText(items: (BlockNode | InlineNode)[]): TextNode[] {
  return items.flatMap((n) => (isText(n) ? [n] : isInline(n) ? n.content : []));
}

function inlines(items: (BlockNode | InlineNode)[]): InlineNode[] {
  return tidy(items.filter(isInline));
}

/** A non-paragraph block reduced to paragraphs of its text, for containers that only hold paragraphs. */
function asParagraphs(block: BlockNode): BlockNode[] {
  const parts = block.content.flatMap((c) => (isInline(c) ? [c] : asParagraphs(c).flatMap((p) => p.content as InlineNode[])));
  const cleaned = tidy(parts);
  return cleaned.length ? [paragraph(cleaned)] : [];
}

/**
 * Groups a flow into blocks: consecutive inline nodes become one paragraph,
 * BREAK markers split paragraphs, blocks pass through. Empty paragraphs
 * (whitespace, &nbsp;) disappear here.
 */
function group(items: (BlockNode | InlineNode)[]): BlockNode[] {
  const out: BlockNode[] = [];
  let run: InlineNode[] = [];
  const flush = () => {
    const cleaned = tidy(run);
    if (cleaned.length) out.push(paragraph(cleaned));
    run = [];
  };
  for (const item of items) {
    if (item === BREAK) flush();
    else if (isInline(item)) run.push(item);
    else {
      flush();
      out.push(item as BlockNode);
    }
  }
  flush();
  return out;
}

const collapse = (s: string) => s.replace(/[ \t\r\f\v ]*\n[ \t\r\f\v ]*/g, "\n").replace(/[ \t\r\f\v ]+/g, " ");

/** Collapses whitespace like a browser, merges neighbouring text with equal marks, trims the edges; returns [] when nothing visible is left. */
function tidy(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const n of nodes) {
    const node = isText(n) ? { ...n, value: n.value === "\n" ? "\n" : collapse(n.value.replace(/\n/g, " ")) } : { ...n, content: tidy(n.content) as TextNode[] };
    const prev = merged[merged.length - 1];
    if (prev && isText(prev) && isText(node) && sameMarks(prev, node)) prev.value += node.value;
    else merged.push(node);
  }
  // Collapse spaces across node boundaries, then trim the paragraph's edges.
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1] as InlineNode;
    const b = merged[i] as InlineNode;
    if (isText(a) && isText(b) && /[ \n]$/.test(a.value)) b.value = b.value.replace(/^ +/, "");
  }
  const first = merged[0];
  if (first && isText(first)) first.value = first.value.replace(/^[ \n]+/, "");
  const last = merged[merged.length - 1];
  if (last && isText(last)) last.value = last.value.replace(/[ \n]+$/, "");
  const kept = merged.filter((n) => !isText(n) || n.value !== "");
  const visible = kept.some((n) => (isText(n) ? n.value.trim() !== "" : n.content.some((t) => t.value.trim() !== "")));
  return visible ? kept : [];
}

function sameMarks(a: TextNode, b: TextNode): boolean {
  return a.marks.length === b.marks.length && a.marks.every((m, i) => m.type === b.marks[i]?.type);
}

function nextTag(nodes: ChildNode[], i: number): Element | null {
  for (let j = i + 1; j < nodes.length; j++) {
    const n = nodes[j] as ChildNode;
    if (n.type === "text" && !(n as unknown as { data: string }).data.trim()) continue;
    return n.type === "tag" ? (n as Element) : null;
  }
  return null;
}

function findTag(el: Element, name: string): Element | null {
  for (const c of el.children) {
    if (c.type !== "tag") continue;
    const child = c as Element;
    if (child.name === name) return child;
    const found = findTag(child, name);
    if (found) return found;
  }
  return null;
}

function allTags(el: Element, name: string): Element[] {
  return el.children.flatMap((c) => {
    if (c.type !== "tag") return [];
    const child = c as Element;
    return child.name === name ? [child] : allTags(child, name);
  });
}

const INLINE_TYPES = new Set(["text", "hyperlink", "entry-hyperlink", "asset-hyperlink", "embedded-entry-inline"]);

/** Every text value in a rich-text tree, in order: inline runs joined directly, blocks separated by newlines. */
export function documentText(node: { nodeType: string; value?: string; content?: unknown[] }): string {
  if (node.nodeType === "text") return node.value ?? "";
  const children = (node.content ?? []) as { nodeType: string }[];
  const sep = children.every((c) => INLINE_TYPES.has(c.nodeType)) ? "" : "\n";
  return children.map((c) => documentText(c)).join(sep);
}

