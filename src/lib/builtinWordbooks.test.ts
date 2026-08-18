import { describe, expect, it } from "vitest";
import { BUILTIN_WORDBOOKS, getBuiltinWordbook, isBuiltinWordbookId } from "./builtinWordbooks";

describe("builtin wordbook catalog", () => {
  it("contains the requested domestic and international exam groups", () => {
    expect(BUILTIN_WORDBOOKS).toHaveLength(10);
    expect(BUILTIN_WORDBOOKS.filter((book) => book.category === "domestic-exam")).toHaveLength(5);
    expect(BUILTIN_WORDBOOKS.filter((book) => book.category === "international-exam")).toHaveLength(5);
  });

  it("keeps stable IDs for selecting a wordbook", () => {
    expect(getBuiltinWordbook("builtin-ielts")?.shortName).toBe("IELTS");
    expect(isBuiltinWordbookId("builtin-gre")).toBe(true);
    expect(isBuiltinWordbookId("custom-reading")).toBe(false);
  });
});
