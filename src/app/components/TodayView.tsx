import type { ContextPack, WordCard } from "@/lib/types";
import {
  getPlanEntry,
  isPlanEntryComplete,
  isPlanRowUnlocked,
  type PlanEntry,
  type ReviewColumn,
} from "../learning-config";

type DayRange = { label: string; start: number; end: number };

type TodayViewProps = {
  activeGroup: number;
  setActiveGroup: (index: number) => void;
  dayGroups: DayRange[];
  reviewColumns: ReviewColumn[];
  totalDays: number;
  completedDays: number[];
  nextDay: number;
  dailyNewWords: number;
  completedReviewEntries: string[];
  onOpenDay: (entry: PlanEntry) => void;
  onReview: () => void;
  due: number;
  cards: WordCard[];
  packs: ContextPack[];
  accuracy: number;
};

export function TodayView({
  activeGroup,
  setActiveGroup,
  dayGroups,
  reviewColumns,
  totalDays,
  completedDays,
  completedReviewEntries,
  nextDay,
  dailyNewWords,
  onOpenDay,
  onReview,
  due,
  cards,
  packs,
  accuracy,
}: TodayViewProps) {
  const group = dayGroups[activeGroup] ?? dayGroups[0];
  const currentGroup = dayGroups.findIndex(
    (item) => nextDay >= item.start && nextDay <= item.end,
  );
  const todayComplete = completedDays.includes(Math.max(1, nextDay - 1));

  return (
    <div className="plan-stack">
      <section className="plan-layout">
        <aside className="plan-sidebar" aria-label="学习单元">
          <div className="sidebar-title">学习单元</div>
          {dayGroups.map((item, index) => (
            <button
              type="button"
              className={`sidebar-group ${activeGroup === index ? "selected" : ""}`}
              key={item.label}
              aria-label={`查看第 ${item.start} 至 ${item.end} 天计划${index === currentGroup ? "，当前学习单元" : ""}`}
              onClick={() => setActiveGroup(index)}
            >
              <span className="sidebar-range">{item.label}</span>
              <span className="sidebar-state">
                {index === currentGroup ? "当前" : "计划"}
              </span>
            </button>
          ))}
          <div className="sidebar-rule" />
          <button type="button" className="plan-settings" onClick={onReview}>
            复习到期词 <strong>{due}</strong>
          </button>
          <div className="sidebar-progress">
            <span>今日学习进度</span>
            <strong>{todayComplete ? "100" : "0"}%</strong>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${todayComplete ? 100 : 0}%` }}
              />
            </div>
            <span>
              总学习进度 {completedDays.length}/{totalDays} 天
            </span>
          </div>
        </aside>

        <section className="plan-board">
          <div className="plan-board-head">
            <div>
              <p className="eyebrow">Study plan / 复习计划</p>
              <h1>按计划重排，按语境记住。</h1>
              <p className="lede">
                按学习日依次推进；完成上一排全部任务后，下一排自动解锁。
              </p>
            </div>
            <div className="plan-meta">
              <strong>{nextDay}</strong>
              <span>当前学习日</span>
            </div>
          </div>

          <div className="plan-table-wrap">
            <table className="study-plan">
              <thead>
                <tr>
                  <th>No.</th>
                  {reviewColumns.map((column) => (
                    <th key={column.label}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from(
                  { length: group.end - group.start + 1 },
                  (_, index) => {
                    const row = group.start + index;
                    const applicable = reviewColumns.findIndex(
                      (column) => row >= column.start && row <= column.end,
                    );
                    const rowUnlocked = isPlanRowUnlocked(
                      row,
                      reviewColumns,
                      completedDays,
                      completedReviewEntries,
                    );

                    return (
                      <tr key={row}>
                        <td className="row-number">{row}</td>
                        {reviewColumns.map((column, columnIndex) => {
                          const entry = getPlanEntry(row, column);
                          const hasNumber = entry !== null;
                          const value = entry?.sourceDay ?? "/";
                          const isComplete = entry
                            ? isPlanEntryComplete(entry, completedDays, completedReviewEntries)
                            : false;
                          const isCurrent =
                            row === nextDay && columnIndex === applicable;

                          return (
                            <td
                              key={column.label}
                              className={`${isComplete ? "cell-done" : ""} ${isCurrent && rowUnlocked ? "cell-current" : ""} ${!hasNumber || !rowUnlocked ? "cell-locked" : ""}`}
                            >
                              <button
                                type="button"
                                disabled={!hasNumber || !rowUnlocked}
                                aria-label={
                                  entry
                                    ? `${entry.kind === "learn" ? "学习" : "复习"}第 ${entry.sourceDay} 天${isComplete ? "，已完成" : !rowUnlocked ? "，完成上一学习日后解锁" : ""}`
                                    : undefined
                                }
                                onClick={() => entry && onOpenDay(entry)}
                              >
                                {isComplete && entry?.kind === "review" ? (
                                  <span aria-hidden="true">✓</span>
                                ) : (
                                  value
                                )}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>

          <div className="plan-foot">
            <span>已完成 {completedDays.length} 天</span>
            <span>
              约 {dailyNewWords} 个新词/日 · 计划 {totalDays} 天 ·{" "}
              {packs.at(-1)?.targetWords.length ?? 0} 个目标词 · {cards.length}{" "}
              张词卡 · 正确率 {accuracy}%
            </span>
          </div>
        </section>
      </section>
    </div>
  );
}
