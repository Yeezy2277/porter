import { describe, expect, it, vi } from "vitest";
import modelJson from "../../samples/contentful-model.json";
import { checkMapping } from "@/core/mapping";
import { contentType, parseModel } from "@/core/model";

vi.mock("./env", () => ({ serverEnv: () => ({ databaseUrl: null, live: null, voyage: null, record: false }) }));
const { structured } = await import("./llm");
const { mappingCall } = await import("./map");

describe("the recorded mapping proposal", () => {
  // Fails when the prompt, the sample posts or the model changes without re-recording:
  // run once with ANTHROPIC_API_KEY and PORTER_RECORD=true.
  it("exists for today's exact prompt and passes code's checks", async () => {
    const r = await structured(mappingCall("article"));
    expect(r.mode).toBe("replay");
    expect(checkMapping(r.output, contentType(parseModel(modelJson), "article")).filter((p) => p.severity === "error")).toEqual([]);
  });
});
