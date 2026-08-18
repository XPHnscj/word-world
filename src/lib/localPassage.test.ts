import { describe, expect, it } from "vitest";
import { countEnglishWords, findDuplicateTarget, findMissingTargets } from "./contextPack";
import { buildLocalPassage } from "./localPassage";

describe("buildLocalPassage", () => {
  it("keeps the local fallback compact and covers each target once", () => {
    const words = ["scuffle", "cushion", "literal", "knob", "reckon", "motel", "phobia", "hypothesis", "ferocious", "world-wide"];
    const passage = buildLocalPassage(words);

    expect(countEnglishWords(passage)).toBeGreaterThanOrEqual(75);
    expect(countEnglishWords(passage)).toBeLessThanOrEqual(110);
    expect(findMissingTargets(passage, words)).toEqual([]);
    expect(findDuplicateTarget(passage, words)).toBeNull();
  });

  it("does not duplicate a target that also appears in the template", () => {
    const words = ["student", "the", "policy", "note", "adapt"];
    const passage = buildLocalPassage(words, "story");

    expect(findMissingTargets(passage, words)).toEqual([]);
    expect(findDuplicateTarget(passage, words)).toBeNull();
  });
});
