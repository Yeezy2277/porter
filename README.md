# Porter

[![CI](https://github.com/Yeezy2277/porter/actions/workflows/ci.yml/badge.svg)](https://github.com/Yeezy2277/porter/actions/workflows/ci.yml)

Moves a legacy CMS export into Contentful. **Code converts the text; Claude does the parts that need judgement; a person approves before anything is written.**

**Live demo: [porter.vitaliipopov.dev](https://porter.vitaliipopov.dev).** Walk the stages in order: [Map](https://porter.vitaliipopov.dev/map) → [Link](https://porter.vitaliipopov.dev/link) → [Migrate](https://porter.vitaliipopov.dev/migrate) → [Evals](https://porter.vitaliipopov.dev/evals). The public demo replays recorded model answers, so it costs nothing and behaves the same every time; the database (Neon) is real and shared, and each stage has a Reset.

Sample data is a fictional travel magazine's WordPress export ([`samples/`](samples)). No real site or space is contacted unless you configure one.

## At a glance

| | |
|---|---|
| What | A WordPress → Contentful migration where code converts the text and Claude only makes judgement calls. A learning project I built on my own, not client work. |
| Try it | [Live demo](https://porter.vitaliipopov.dev), no sign-up and no API keys: it replays recorded model answers. Locally: `npm install && npm run dev`. |
| Retrieval | Hybrid search (Voyage embeddings in pgvector + Postgres full-text, Reciprocal Rank Fusion): **98% correct, 96% retrieval recall on 53 hand-labelled cases**. |
| Agent | Hand-written tool loop, 6 tools, **max 10 turns and $0.40 per post**, every tool input validated; anything uncertain goes to a human review queue. Recorded run: 9 posts, 3–4 turns each, about **$0.013 per post**. |
| Evals | Linking and agent evals run in CI on recorded answers and **fail the build below set floors**; a separate Haiku judge scores the free text, checked against known-bad inputs. |
| Guardrails | The model never writes article text; a word-level diff proves each body survived. Model-written fields are checked for names and numbers the source doesn't contain. |
| Honest limits | Small eval sets (n=53 and 19), so metrics sit near their ceiling with wide intervals; the judge's agreement with human labels is still being measured. |

**Why the conversion isn't an agent:** turning HTML into rich text has a right answer, so it's a deterministic workflow that can be proved word for word. The agent only gets the open-ended part (summaries, region, review notes), where judgement is the job.

## Why it exists

I work with Contentful (the newsroom rich-text editor at Paris Match, Contentful Certified Professional) and I ship features with a coding agent every day. Porter is where I build the LLM side properly, in public: structured output, retrieval, a tool-using agent and evals, on a problem I know well.

It is **not** a rebuild of client work. Migrations like this one are a common Contentful job; the code and data here are written from scratch.

## The rule that shapes everything

**The model never writes article text.** Bodies go through a deterministic HTML → Rich Text transform, and a separate check proves the migrated body has the same words, in the same order, as the old page. The model is used only where rules run out:

| Stage | What happens | Who decides | Status |
|---|---|---|---|
| 01 Convert | HTML → Contentful Rich Text, word-for-word check | code | built |
| 02 Map | Source fields → target fields, with transforms | Claude proposes (structured output), you approve | built |
| 03 Link | Authors and topics matched to entries that already exist | retrieval (embeddings + keyword), Claude decides close calls | built |
| 04 Migrate | An agent assembles each entry with tools, validates, retries | agent, then a human review queue | built |
| 05 Measure | Golden set, scorers, report per prompt version | evals in CI on recorded responses | built |

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

## Stage 03: link (retrieval-augmented)

The new space already has 16 authors and 36 topics, some of them deliberate near-misses: Tom Brennan (former mountain guide) and Tomas Brenner (restaurant critic). Each WordPress author and term has to land on the right one, become a new entry, or be skipped.

1. **Index.** Every existing entry is embedded (Voyage AI `voyage-3.5-lite`, 512 dimensions, called with `fetch`) and stored in Postgres with **pgvector** (HNSW index) next to a full-text column (GIN index, English stemming). The same schema runs on Neon and on PGlite.
2. **Hybrid retrieval.** Each source item is searched two ways: nearest neighbours by cosine similarity, and full-text matches. The rankings are combined with **Reciprocal Rank Fusion**, which uses ranks rather than scores, so the two never need calibrating against each other.
3. **Rules first.** Code settles the same name once accents and punctuation are ignored (`Ana Lucia Ortega` = `Ana-Lucía Ortega`), and WordPress's default category.
4. **Claude decides the rest**, one call per content type. It may only choose an entry retrieved for that item (an enum in the output schema), and it must quote its evidence.
5. **Code checks every decision.** The entry must have been retrieved for *this* item, the quote must exist in the source or the chosen entry, and tags never create topics. A flagged item blocks approval until a person decides it. A reviewer can pick *any* entry, which fixes retrieval misses; Claude can't.

Recorded run: 21 items, 3 settled by rules, 18 by Claude in 2 calls, no decision flagged by the checks.
- `Tom B.` → Tom Brennan: the bios agree.
- `Eating Out` → Food & Drink: no shared words, found by meaning.
- `Interrail` → Rail Travel, `Kyoto` → Japan.

One honest miss: `Northbound Staff` has no bio, and retrieval never surfaces `Editorial Desk`, so Claude proposes a new author. That is the reviewer's override in the demo, and the kind of case the evals in stage 05 count.

Without keys, the local hashing embedder stands in. It is fine for spelling variants and blind to meaning; the UI says which embedder built the index, and vectors from two embedders are never compared.

## Stage 04: migrate (an agent with tools)

For each post an agent reads the source, fills the draft from the approved mapping and links, writes the fields left to it, checks the draft and submits it to a review queue, or flags it for a person.

- **The loop is hand-written, not the SDK's tool runner.** Every turn is recorded for replay (keyed by the whole conversation so far), the loop enforces limits (10 turns, $0.40 per post), and every tool input is validated with Zod before it runs. The model call is injected, so tests drive the loop with a scripted model.
- **Six tools:** `read_post`, `apply_mapping`, `write_field`, `validate_draft`, `submit_for_review`, `flag_for_human`. `write_field` takes an **enum of exactly the fields this post leaves to the agent**, so it can't touch the title or the body.
- **Every write is checked** against the field's rules and against the source: no number or proper name that isn't in the post. Rejections go back to the model as tool errors with the reason, and it rewrites.
- **Thinking blocks go back unchanged** on every turn. Parallel tool calls return in one message. Automatic prompt caching makes each turn re-read the conversation from cache.
- **The trace streams to the page** (newline-delimited JSON from a route handler): tool calls, rejections, tokens, cache hits and cost per turn.
- **Provenance per field** in the review queue: mapping, link, agent or reviewer. Reviewers edit the agent's text (re-checked on the server) and approve only the version they saw.

Recorded run: all 9 posts submitted in 3–4 turns each, about $0.12 in total, no write rejected. The agent's notes to reviewers are the best part:
- the Chamonix post says "four huts" while its table lists three;
- a publish time of 23:00 UTC is 1 April locally;
- the Northbound Staff byline was linked to a new author: worth a check.

**The first recording run found three bugs in my code, not in the model.** The agent flagged four posts instead of guessing, and each flag pointed at a real defect:
- the validator treated links to entries the migration itself creates (cross-linked articles, video embeds) as missing;
- an optional field left empty on purpose blocked submitting;
- `ungrounded` took a sentence's first word ("Planning") for a proper name.

Each one has a regression test.

## Stage 05: measure (evals)

Two evals, one per flow, run through the app's real entry points (`proposeLinks`, `runAgent`) on cases with **hand-written gold answers** (`samples/evals/`). They are never copied from model output, because then the eval would only reward imitation. Ambiguous cases accept several answers.

- **Linking: 53 cases** (the 21 demo items plus near-miss names, abbreviations, semantic matches, no-match items), graded by code. Retrieval recall is measured separately from the decision, so a miss is attributed to search or to judgement.
- **Agent: 19 posts** (the 9 demo posts plus 10 with traps: prices and distances, empty or short excerpts, no place at all, regions outside Europe).
  - Code grades submission, field rules, grounding (re-checked on the final draft) and region against gold.
  - A judge (Claude **Haiku 5.5**, not the model under test) answers four yes/no questions on summaries and SEO descriptions: faithful, specific, plain, fit for purpose.
- **Is the judge trustworthy?**
  - It fails four known-bad inputs (empty, "I don't know", the wrong article, hype).
  - A person labels 29 texts **blind** at `/evals/label`, eight of them flawed on purpose, so a judge that passes everything can't look calibrated. `npm run eval -- calibrate` reports its agreement.
- **Runner:** `npm run eval -- linking|agent|calibrate|negatives`.
  - It **replays by default**, even with keys in `.env`; `--live` is required to spend money.
  - Results follow the standard eval-report layout (`results.jsonl`, per-case traces).
  - CI runs both evals and fails below the floors in `evals/thresholds.json`.

Results (recorded run):

| Eval | Result |
|---|---|
| Linking | 98% correct (±4, n=53), retrieval recall 96%. The one miss is `Northbound Staff`, and the eval attributes it to retrieval. |
| Agent | 19/19 submitted; rules, grounding and region 100%; the judge passes all 14 written fields. |

Live cost of a full run: about $0.17 for linking, $0.15 for the agent and under $0.01 for the judge.

Two findings were bugs in the eval itself:
- the judge didn't see the excerpt the agent saw, and failed a true SEO description;
- the runner went live because of keys in `.env`, so it replays by default now.

**Honest limit.** Every metric is at or near its ceiling, with ±4 to ±23 points of noise at these sizes. The evals guard against regressions; showing that a new prompt is better would need harder cases.

## Run it

```bash
npm install
npm run dev     # http://localhost:3000
npm test
npm run eval -- linking   # replays the recorded eval, no keys needed
```

No configuration needed: embedded Postgres (PGlite) and recorded model answers. To call Claude and Voyage live, put `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` in `.env` (see `.env.example`); add `PORTER_RECORD=true` to save new answers and vectors for replay.

## Stack

Next.js 15 (App Router), TypeScript strict, Zod, Anthropic SDK (structured output), Drizzle on Postgres (Neon / PGlite) with pgvector, Voyage AI embeddings, htmlparser2, `@contentful/rich-text-types`, Vitest + Testing Library.

## Design

A shipping manifest. The fonts are Big Shoulders Stencil (crate stencils), Martian Mono for ids and data, and Instrument Sans for reading. The palette is kraft paper, ultramarine stamp ink and hazard-label yellow. Statuses are rubber stamps. Light and dark themes; respects reduced motion.
