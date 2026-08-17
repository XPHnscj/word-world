import type { WordCard } from "@/lib/types";

type ProgressViewProps = {
  cards: WordCard[];
  attempts: Array<{ correct: boolean; confidence: number }>;
  accuracy: number;
};

const DIMENSIONS = [
  ["recognition", "识义"],
  ["recall", "回忆"],
  ["collocation", "搭配"],
  ["reading", "阅读"],
  ["transfer", "迁移"],
] as const;

export function ProgressView({ cards, attempts, accuracy }: ProgressViewProps) {
  const averageConfidence = attempts.length
    ? (
        attempts.reduce((sum, attempt) => sum + attempt.confidence, 0) /
        attempts.length
      ).toFixed(1)
    : "0.0";

  return (
    <div className="page-view progress-view stack">
      <section className="panel progress-summary">
        <p className="eyebrow">Evidence / 学习证据</p>
        <h1>看见你真正会用的部分。</h1>
        <div className="grid grid-3 progress-metrics">
          <div className="metric">
            <strong>{accuracy}%</strong>
            <span>总体正确率</span>
          </div>
          <div className="metric">
            <strong>{averageConfidence}</strong>
            <span>平均自信度</span>
          </div>
          <div className="metric">
            <strong>{cards.filter((card) => card.stage === "stable").length}</strong>
            <span>稳定词卡</span>
          </div>
        </div>
      </section>

      <section className="panel progress-dimensions">
        <div className="section-head">
          <h2>能力维度</h2>
          <span className="small muted">每张词卡独立记录</span>
        </div>
        {DIMENSIONS.map(([dimension, label]) => {
          const value = cards.length
            ? Math.round(
                cards.reduce(
                  (sum, card) => sum + card.dimensions[dimension],
                  0,
                ) / cards.length,
              )
            : 0;

          return (
            <div className="dimension-row" key={dimension}>
              <div className="section-head">
                <span>{label}</span>
                <span className="status">{value}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${value}%` }} />
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
