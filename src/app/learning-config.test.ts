import { describe, expect, it } from "vitest";
import { buildDayGroups, buildReviewColumns, getPlanEntry, isPlanRowComplete, isPlanRowUnlocked, planEntryKey } from "./learning-config";

describe("learning plan configuration", () => {
  it("keeps a numeric learning entry available through the final day", () => {
    const columns = buildReviewColumns(400);

    expect(columns[0]).toEqual({ label: "First", start: 1, end: 400, kind: "learn" });
    expect(columns.every((column) => column.end === 400)).toBe(true);
  });

  it("maps each review cell back to its source learning day", () => {
    const columns = buildReviewColumns(400);
    const day2 = columns.find((column) => column.label === "Day 2")!;
    const day30 = columns.find((column) => column.label === "Day 30")!;

    expect(getPlanEntry(3, day2)).toEqual({
      sourceDay: 1,
      scheduleDay: 3,
      columnLabel: "Day 2",
      kind: "review",
    });
    expect(planEntryKey(getPlanEntry(31, day30)!)).toBe("31:Day 30:1");
  });

  it("groups the complete plan without dropping the final day", () => {
    const groups = buildDayGroups(400);

    expect(groups[0]).toEqual({ label: "01–21", start: 1, end: 21 });
    expect(groups.at(-1)).toEqual({ label: "400–400", start: 400, end: 400 });
  });

  it("unlocks a row only after every task in the previous row is complete", () => {
    const columns = buildReviewColumns(40);

    expect(isPlanRowUnlocked(1, columns, [], [])).toBe(true);
    expect(isPlanRowUnlocked(2, columns, [], [])).toBe(false);
    expect(isPlanRowUnlocked(2, columns, [1], [])).toBe(true);

    // 第 2 排含 First 2 和 Day 1 的复习 1，缺少任一项都不能解锁第 3 排。
    expect(isPlanRowComplete(2, columns, [1, 2], [])).toBe(false);
    expect(isPlanRowUnlocked(3, columns, [1, 2], [])).toBe(false);
    expect(isPlanRowComplete(2, columns, [1, 2], ["2:Day 1:1"])).toBe(true);
    expect(isPlanRowUnlocked(3, columns, [1, 2], ["2:Day 1:1"])).toBe(true);
  });
});
