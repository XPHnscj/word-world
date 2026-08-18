import { describe, expect, it } from "vitest";
import { parseSimpleTsv } from "./wordbookVocab";

describe("parseSimpleTsv", () => {
  it("keeps words and turns source translations into readable definitions", () => {
    expect(
      parseSimpleTsv("abruptly\tadv::突然地\nabsorb\tv::吸收¦absorb in::集中精力\n"),
    ).toEqual([
      { lemma: "abruptly", definition: "突然地" },
      { lemma: "absorb", definition: "吸收；集中精力" },
    ]);
  });

  it("ignores invalid rows and duplicate lemmas", () => {
    expect(parseSimpleTsv("\uFEFFword\t释义\nword\t重复\n中文\t跳过\n" )).toEqual([
      { lemma: "word", definition: "释义" },
    ]);
  });
});

