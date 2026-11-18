import { describe, expect, it } from "vitest";
import linkingJson from "../../samples/evals/linking.json";
import evalPosts from "../../samples/evals/posts.json";
import modelJson from "../../samples/contentful-model.json";
import { contentType, parseModel } from "@/core/model";
import type { Candidate } from "@/core/link";
import { agreement, gradeAgent, gradeLinking, LinkingCase, rate, type AgentGold } from "./grade";

const cases = linkingJson.cases.map((c) => LinkingCase.parse(c));
const ct = contentType(parseModel(modelJson), "article");
const resolve = () => "asset";
const cand = (entryId: string): Candidate => ({ entryId, name: entryId, text: entryId, similarity: 0.5, vectorRank: 1, keywordRank: 1, fused: 0.03 });
const decision = (answer: string) => (answer.startsWith("link:") ? { decision: "link" as const, entryId: answer.slice(5), decidedBy: "claude" as const } : { decision: answer as "new" | "skip", entryId: null, decidedBy: "claude" as const });

describe("linking grader (oracle and null baselines)", () => {
  it("scores the gold answers 100%", () => {
    const g = cases.map((c) => gradeLinking(c, decision(c.accept[0]!), [cand(c.accept[0]!.replace("link:", ""))]));
    expect(rate(g.map((x) => x.correct)).mean).toBe(1);
  });

  it("scores 'skip everything' low: only the cases where skipping is right", () => {
    const g = cases.map((c) => gradeLinking(c, decision("skip"), []));
    const skippable = cases.filter((c) => c.accept.includes("skip")).length;
    expect(g.filter((x) => x.correct).length).toBe(skippable);
    expect(rate(g.map((x) => x.correct)).mean).toBeLessThan(0.15);
  });

  it("separates retrieval misses from decision misses", () => {
    const tom = cases.find((c) => c.id === "demo-author-3")!;
    expect(gradeLinking(tom, decision("new"), [cand("author-brenner")])).toMatchObject({ correct: 0, retrieval: 0 });
    expect(gradeLinking(tom, decision("new"), [cand("author-brennan")])).toMatchObject({ correct: 0, retrieval: 1 });
    expect(gradeLinking(cases.find((c) => c.id === "x-tag-sunsets")!, decision("skip"), [])).toMatchObject({ correct: 1, retrieval: null });
  });
});

describe("agent grader", () => {
  const gold: AgentGold = evalPosts.posts.find((p) => p.id === 1302)!.gold as AgentGold;
  const source = "A Weekend in Mexico City. Coyoacán, Chapultepec Park. On Sunday, Paseo de la Reforma closes to cars. Tacos al pastor.";
  const oracle = {
    status: "submitted" as const,
    draft: { contentType: "article", id: "a", fields: { summary: "A slow weekend in Mexico City: Coyoacán, the museum in Chapultepec Park and Sunday cycling on Paseo de la Reforma.", region: "Americas" } },
    provenance: { summary: { origin: "agent" as const, detail: "" }, region: { origin: "agent" as const, detail: "" } },
  };

  it("passes a correct outcome on every property", () => {
    expect(gradeAgent(oracle, gold, ct, source, resolve)).toEqual({ submitted: 1, rules: 1, grounded: 1, region: 1 });
  });

  it("fails an empty or wrong outcome on the right properties", () => {
    expect(gradeAgent({ ...oracle, status: "stopped", draft: { ...oracle.draft, fields: {} }, provenance: {} }, gold, ct, source, resolve)).toMatchObject({ submitted: 0, region: 0 });
    const invented = { ...oracle, draft: { ...oracle.draft, fields: { ...oracle.draft.fields, summary: "Mexico City in 48 hours, from Frida Kahlo's house to tacos for 20 pesos." } } };
    expect(gradeAgent(invented, gold, ct, source, resolve)).toMatchObject({ grounded: 0 });
    const tooShort = { ...oracle, draft: { ...oracle.draft, fields: { ...oracle.draft.fields, summary: "Tacos." } } };
    expect(gradeAgent(tooShort, gold, ct, source, resolve)).toMatchObject({ rules: 0 });
  });

  it("accepts an empty region only where the gold allows it", () => {
    const noRegion = { ...oracle, draft: { ...oracle.draft, fields: { summary: oracle.draft.fields.summary } } };
    expect(gradeAgent(noRegion, gold, ct, source, resolve).region).toBe(0);
    expect(gradeAgent(noRegion, { region: [null], traps: [] }, ct, source, resolve).region).toBe(1);
  });
});

describe("judge agreement", () => {
  it("counts agreement per criterion and overall", () => {
    const t = { faithful: true, specific: true, plain: true, purpose: true };
    const a = agreement([
      { judge: t, human: t },
      { judge: { ...t, plain: false }, human: t },
    ]);
    expect(a.per.plain).toEqual({ n: 2, agree: 1, rate: 0.5 });
    expect(a.rate).toBe(7 / 8);
  });
});
