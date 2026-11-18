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
| 02 Map | Source fields → target fields, with transforms | Claude proposes (structured output), you approve | built |
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

## Stage 02: map

Claude proposes which source field fills each target field, and how. It sees real sample values and every rule of the target type. A person reviews, edits and approves; code applies.

- **A closed menu.** The output schema (Zod, enforced by the API) lists the 11 source fields and the 10 transforms as enums. The model picks; it can't invent a field or write code. `checkMapping` then checks types, required fields and duplicates, in the browser on every edit and again on the server.
- **Fallbacks by rule, not by emptiness.** A fallback runs when the source is empty *or* breaks the field's rules: an excerpt shorter than the summary's 40-character minimum gets a generated summary (stage 04), and a valid source always wins.
- **Approval is pinned to what you saw.** The server approves only the version you reviewed, and any edit drops the approval.
- **Record and replay.** Each answer is stored under a hash of (prompt version, system, user). The demo and CI replay it with no key; a prompt change can't reuse an old answer, and a test fails until it's recorded again.
- **Every call is logged** with tokens, cost and time. On Vercel, live calls are off unless `PORTER_LIVE=true`.

First live run (Claude Opus 5.5, prompt `map-v1`): 10/10 fields mapped with no errors from the checks, five questions for the editor, 4,030 in / 1,591 out tokens, $0.05, 17.6 s.

## Run it

```bash
npm install
npm run dev     # http://localhost:3000
npm test
```

No configuration needed: embedded Postgres (PGlite) and recorded model answers. To call Claude live, put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`); add `PORTER_RECORD=true` to save new answers for replay.

## Stack

Next.js 15 (App Router), TypeScript strict, Zod, Anthropic SDK (structured output), Drizzle on Postgres (Neon / PGlite), htmlparser2, `@contentful/rich-text-types`, Vitest + Testing Library.

## Design

A shipping manifest. The fonts are Big Shoulders Stencil (crate stencils), Martian Mono for ids and data, and Instrument Sans for reading. The palette is kraft paper, ultramarine stamp ink and hazard-label yellow. Statuses are rubber stamps. Light and dark themes; respects reduced motion.
