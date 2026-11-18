import { z } from "zod";
import { validateRichTextDocument, type Document } from "@contentful/rich-text-types";
import type { Mark, TransformOptions } from "./richtext";

/**
 * The target side: Contentful content types in the Management API shape
 * (GET /spaces/:id/environments/:env/content_types), and a validator that
 * checks an entry draft the way Contentful would, before anything is sent.
 */

const Validation = z
  .object({
    size: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    regexp: z.object({ pattern: z.string() }).optional(),
    in: z.array(z.string()).optional(),
    unique: z.boolean().optional(),
    linkContentType: z.array(z.string()).optional(),
    enabledNodeTypes: z.array(z.string()).optional(),
    enabledMarks: z.array(z.string()).optional(),
    nodes: z.record(z.string(), z.array(z.object({ linkContentType: z.array(z.string()).optional() }))).optional(),
  })
  .passthrough();
export type Validation = z.infer<typeof Validation>;

const FieldType = z.enum(["Symbol", "Text", "RichText", "Integer", "Number", "Date", "Boolean", "Link", "Array", "Object", "Location"]);

const Field = z.object({
  id: z.string(),
  name: z.string(),
  type: FieldType,
  required: z.boolean(),
  localized: z.boolean(),
  linkType: z.enum(["Entry", "Asset"]).optional(),
  validations: z.array(Validation).default([]),
  items: z.object({ type: z.string(), linkType: z.enum(["Entry", "Asset"]).optional(), validations: z.array(Validation).default([]) }).optional(),
});
export type Field = z.infer<typeof Field>;

const ContentType = z.object({ sys: z.object({ id: z.string() }), name: z.string(), displayField: z.string(), fields: z.array(Field) });
export type ContentType = z.infer<typeof ContentType>;

export function parseModel(input: unknown): ContentType[] {
  return z.object({ items: z.array(ContentType) }).parse(input).items;
}

export function contentType(model: readonly ContentType[], id: string): ContentType {
  const ct = model.find((c) => c.sys.id === id);
  if (!ct) throw new Error(`Content type "${id}" is not in the model`);
  return ct;
}

/** What a rich-text field allows, as transform options. With no validation, Contentful allows everything. */
export function richTextRules(field: Field): Pick<TransformOptions, "enabledNodeTypes" | "enabledMarks"> {
  const nodes = field.validations.find((v) => v.enabledNodeTypes)?.enabledNodeTypes;
  const marks = field.validations.find((v) => v.enabledMarks)?.enabledMarks;
  const always = ["paragraph", "text", "list-item", "table-row", "table-cell", "table-header-cell"];
  const everything = [
    ...always,
    "heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6",
    "ordered-list", "unordered-list", "hr", "blockquote", "table",
    "embedded-entry-block", "embedded-asset-block", "embedded-entry-inline", "hyperlink", "entry-hyperlink", "asset-hyperlink",
  ];
  return {
    enabledNodeTypes: new Set(nodes ? [...always, ...nodes] : everything),
    enabledMarks: new Set((marks ?? ["bold", "italic", "underline", "code"]) as Mark[]),
  };
}

export type Link = { sys: { type: "Link"; linkType: "Entry" | "Asset"; id: string } };
export type FieldValue = string | number | boolean | Document | Link | Link[] | null | undefined;
export type EntryDraft = { contentType: string; id: string; fields: Record<string, FieldValue> };

export type Problem = { field: string; message: string };

/**
 * Resolves what a link points at, so link validations can be checked:
 * the content type of an entry id, or "asset". Unknown ids are problems.
 */
export type Resolver = (link: Link) => string | null;

export function validateEntry(draft: EntryDraft, ct: ContentType, resolve: Resolver): Problem[] {
  const problems: Problem[] = [];
  for (const key of Object.keys(draft.fields)) {
    if (!ct.fields.some((f) => f.id === key)) problems.push({ field: key, message: `"${key}" is not a field of ${ct.name}` });
  }
  for (const field of ct.fields) {
    const value = draft.fields[field.id];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) problems.push({ field: field.id, message: `${field.name} is required` });
      continue;
    }
    problems.push(...checkValue(field, value, resolve).map((message) => ({ field: field.id, message })));
  }
  return problems;
}

/** One field's value against its own rules (no required check): used to decide when a fallback applies. */
export function validateField(field: Field, value: Exclude<FieldValue, null | undefined>, resolve: Resolver): string[] {
  return checkValue(field, value, resolve);
}

function checkValue(field: Field, value: Exclude<FieldValue, null | undefined>, resolve: Resolver): string[] {
  const out: string[] = [];
  const v = field.validations;
  switch (field.type) {
    case "Symbol":
    case "Text": {
      if (typeof value !== "string") return [`${field.name} must be text`];
      // Contentful's hard limits, independent of any size validation.
      const hard = field.type === "Symbol" ? 256 : 50000;
      if (value.length > hard) out.push(`${field.name} is ${value.length} characters; the limit is ${hard}`);
      out.push(...sizeProblems(field.name, value.length, v, "characters"));
      for (const r of v) {
        if (r.regexp && !new RegExp(r.regexp.pattern).test(value)) out.push(`${field.name} doesn't match ${r.regexp.pattern}`);
        if (r.in && !r.in.includes(value)) out.push(`${field.name} must be one of: ${r.in.join(", ")}`);
      }
      return out;
    }
    case "Date":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return [`${field.name} must be an ISO date`];
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return [`${field.name} must carry a time zone (store UTC)`];
      return out;
    case "Link":
      if (!isLink(value)) return [`${field.name} must be a link`];
      return linkProblems(field.name, value, field.linkType, v, resolve);
    case "Array": {
      if (!Array.isArray(value) || !value.every(isLink)) return [`${field.name} must be a list of links`];
      out.push(...sizeProblems(field.name, value.length, v, "items"));
      const ids = value.map((l) => l.sys.id);
      if (new Set(ids).size !== ids.length) out.push(`${field.name} links the same entry twice`);
      for (const link of value) out.push(...linkProblems(field.name, link, field.items?.linkType, field.items?.validations ?? [], resolve));
      return out;
    }
    case "RichText":
      return richTextProblems(field, value, resolve);
    default:
      return out;
  }
}

function sizeProblems(name: string, n: number, v: Validation[], unit: string): string[] {
  const size = v.find((r) => r.size)?.size;
  if (!size) return [];
  if (size.min !== undefined && n < size.min) return [`${name} is ${n} ${unit}; the minimum is ${size.min}`];
  if (size.max !== undefined && n > size.max) return [`${name} is ${n} ${unit}; the maximum is ${size.max}`];
  return [];
}

function isLink(value: unknown): value is Link {
  const sys = (value as Link | null)?.sys;
  return Boolean(sys && sys.type === "Link" && (sys.linkType === "Entry" || sys.linkType === "Asset") && typeof sys.id === "string");
}

function linkProblems(name: string, link: Link, linkType: "Entry" | "Asset" | undefined, v: Validation[], resolve: Resolver): string[] {
  if (linkType && link.sys.linkType !== linkType) return [`${name} must link an ${linkType}`];
  const target = resolve(link);
  if (!target) return [`${name} links ${link.sys.id}, which doesn't exist`];
  const allowed = v.find((r) => r.linkContentType)?.linkContentType;
  if (allowed && link.sys.linkType === "Entry" && !allowed.includes(target)) return [`${name} must link ${allowed.join(" or ")}, not ${target}`];
  return [];
}

function richTextProblems(field: Field, value: unknown, resolve: Resolver): string[] {
  const doc = value as Document;
  if ((doc as { nodeType?: string })?.nodeType !== "document") return [`${field.name} must be a rich-text document`];
  // Structure (which node may contain which) is Contentful's own validator.
  const structural = validateRichTextDocument(doc).map((e) => `${field.name}: ${e.details}${e.path ? ` at ${e.path.join(".")}` : ""}`);
  const { enabledNodeTypes, enabledMarks } = richTextRules(field);
  const nodeRules = field.validations.find((r) => r.nodes)?.nodes ?? {};
  const out = [...structural];
  const seen = new Set<string>();
  const walk = (node: { nodeType: string; marks?: { type: string }[]; data?: { target?: Link }; content?: unknown[] }) => {
    if (!enabledNodeTypes.has(node.nodeType) && node.nodeType !== "document" && !seen.has(node.nodeType)) {
      seen.add(node.nodeType);
      out.push(`${field.name}: ${node.nodeType} isn't enabled in this field`);
    }
    for (const m of node.marks ?? []) {
      if (!enabledMarks.has(m.type as Mark) && !seen.has(`mark:${m.type}`)) {
        seen.add(`mark:${m.type}`);
        out.push(`${field.name}: the ${m.type} mark isn't enabled`);
      }
    }
    const target = node.data?.target;
    if (target && isLink(target)) {
      const resolved = resolve(target);
      const allowed = nodeRules[node.nodeType]?.find((r) => r.linkContentType)?.linkContentType;
      if (!resolved) out.push(`${field.name}: ${node.nodeType} links ${target.sys.id}, which doesn't exist`);
      else if (allowed && target.sys.linkType === "Entry" && !allowed.includes(resolved)) out.push(`${field.name}: ${node.nodeType} must link ${allowed.join(" or ")}, not ${resolved}`);
    }
    for (const c of node.content ?? []) walk(c as typeof node);
  };
  walk(doc as unknown as Parameters<typeof walk>[0]);
  return out;
}
