# Porter

Moves a legacy CMS export into Contentful. **Code converts the text; Claude does the parts that need judgement; a person approves before anything is written.**

Sample data is a fictional travel magazine's WordPress export ([`samples/`](samples)). No real site or space is contacted unless you configure one.

## Why it exists

I work with Contentful (the newsroom rich-text editor at Paris Match, Contentful Certified Professional) and I ship features with a coding agent every day. Porter is where I build the LLM side properly, in public: structured output, retrieval, a tool-using agent and evals, on a problem I know well.

It is **not** a rebuild of client work. Migrations like this one are a common Contentful job; the code and data here are written from scratch.

## The rule that shapes everything

**The model never writes article text.** Bodies go through a deterministic HTML → Rich Text transform, and a separate check proves the migrated body has the same words, in the same order, as the old page. The model is used only where rules run out:

| Stage | What happens | Who decides | Status |
|---|---|---|---|
| 01 Convert | HTML → Contentful Rich Text, word-for-word check | code | built |
| 02 Map | Source fields → target fields, with transforms | Claude proposes (structured output), you approve | next |
| 03 Link | Authors and topics matched to entries that already exist | retrieval (embeddings + keyword), Claude decides close calls | next |
| 04 Migrate | An agent assembles each entry with tools, validates, retries | agent, then a human review queue | next |
| 05 Measure | Golden set, scorers, report per prompt version | evals in CI on recorded responses | next |

## Stage 01: convert

`src/core` is framework-free and fully tested:

- **`source.ts`**: parses the WordPress (wp/v2) export with Zod. Entities decoded once, `date_gmt` read as UTC, the `0000-00-00` draft date treated as unpublished.
- **`richtext.ts`**: HTML → Rich Text on `htmlparser2`. It handles real-export mess:
  - `[caption]` shortcodes become embedded assets, and the caption moves to the asset;
  - `<br><br>` runs become paragraphs, and empty `&nbsp;` paragraphs are dropped;
  - lists can nest, and tables keep their header cells;
  - YouTube iframes become `videoEmbed` entries;
  - links to other posts in the export become entry links.

  Headings, marks and embeds follow the **target field's own validations**. An `h1` in a body becomes `heading-2` when the field allows only 2–4. Everything removed is reported, never dropped silently.
- **`grounding.ts`**: two guardrails that don't trust the transform or the model.
  - `bodyPreserved`: a word-level diff between the old page's visible text and the migrated body. The visible text is extracted independently of the transform.
  - `ungrounded`: every number and proper name in model-written text (summaries, SEO descriptions) must appear in the source.
- **`model.ts`**: checks an entry draft the way Contentful will before it's sent: required fields, sizes, regexps, `in`, link content types, rich-text node rules. It uses Contentful's own `validateRichTextDocument` for structure.

Every sample post converts to a valid document with every word accounted for. That is a test, not a claim (`src/core/core.test.ts`).

## Run it

```bash
npm install
npm run dev     # http://localhost:3000
npm test
```

No configuration needed. Later stages add optional keys (Anthropic, embeddings, a Contentful space); without them the app replays recorded runs.

## Stack

Next.js 15 (App Router), TypeScript strict, Zod, htmlparser2, `@contentful/rich-text-types`, Vitest.

## Design

A shipping manifest. The fonts are Big Shoulders Stencil (crate stencils), Martian Mono for ids and data, and Instrument Sans for reading. The palette is kraft paper, ultramarine stamp ink and hazard-label yellow. Statuses are rubber stamps. Light and dark themes; respects reduced motion.
