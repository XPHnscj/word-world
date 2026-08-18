import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseIelts4000, pickDiverseVocabulary } from "./ieltsVocab";

describe("parseIelts4000", () => {
  it("parses a single word: definition line", () => {
    const entries = parseIelts4000("abandon: lacking restraint or control");
    expect(entries).toEqual([
      { lemma: "abandon", definition: "lacking restraint or control" },
    ]);
  });

  it("merges wrapped definition lines into the previous entry", () => {
    const text =
      "absorption: process of absorbing nutrients into the body after digestion; state of mental\nconcentration\n";
    const entries = parseIelts4000(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].definition).toBe(
      "process of absorbing nutrients into the body after digestion; state of mental concentration",
    );
  });

  it("skips file headers and letter group titles", () => {
    const text =
      "IELTS\n4000 Academic Word List\n\nA\n\nabandon: give up\nB\n\nback: rear part\n";
    const entries = parseIelts4000(text);
    expect(entries.map((entry) => entry.lemma)).toEqual(["abandon", "back"]);
  });

  it("parses the real nglsh-master word list without duplicates", () => {
    const file = path.join(process.cwd(), "nglsh-master", "IELTS-4000.txt");
    const entries = parseIelts4000(readFileSync(file, "utf8"));
    expect(entries.length).toBeGreaterThanOrEqual(4000);
    const lemmas = entries.map((entry) => entry.lemma);
    expect(new Set(lemmas).size).toBe(lemmas.length);
    expect(entries.every((entry) => entry.definition.length > 0)).toBe(true);
    const byLemma = new Map(entries.map((entry) => [entry.lemma, entry.definition]));
    expect(byLemma.get("abandon")).toContain("restraint");
    expect(byLemma.get("allocate")).toBeTruthy();
    expect(byLemma.get("zone")).toBeTruthy();
  });

  it("returns an empty list for empty or header-only input", () => {
    expect(parseIelts4000("")).toEqual([]);
    expect(parseIelts4000("IELTS\n4000 Academic Word List\nA\nB\n")).toEqual([]);
  });
});

describe("pickDiverseVocabulary", () => {
  it("spreads a daily set across different initials", () => {
    const entries = [
      "abandon", "ability", "access", "balance", "benefit", "climate", "decline", "evidence",
    ].map((lemma) => ({ lemma, definition: lemma }));
    const picked = pickDiverseVocabulary(entries, new Set(), 6, () => 0.42);

    expect(picked).toHaveLength(6);
    expect(new Set(picked.map((word) => word[0])).size).toBeGreaterThanOrEqual(4);
  });

  it("excludes learned words and returns only available entries", () => {
    const entries = ["adapt", "balance", "climate"].map((lemma) => ({ lemma, definition: lemma }));
    expect(
      pickDiverseVocabulary(entries, new Set(["balance"]), 5, () => 0.5),
    ).toEqual(expect.arrayContaining(["adapt", "climate"]));
    expect(pickDiverseVocabulary(entries, new Set(["balance"]), 5, () => 0.5)).toHaveLength(2);
  });

  it("spreads a full daily set across initials in the real IELTS word list", () => {
    const file = path.join(process.cwd(), "nglsh-master", "IELTS-4000.txt");
    const entries = parseIelts4000(readFileSync(file, "utf8"));
    const picked = pickDiverseVocabulary(entries, new Set(), 15, () => 0.42);

    expect(picked).toHaveLength(15);
    expect(new Set(picked.map((word) => word[0])).size).toBe(15);
  });
});
