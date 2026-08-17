"use client";

import { useMemo, useState } from "react";
import type { ContextPack, ReviewAttempt, WordCard } from "@/lib/types";

type StatisticsViewProps = {
  cards: WordCard[];
  attempts: ReviewAttempt[];
  packs: ContextPack[];
  completedDays: number[];
};

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function dateKey(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthLabel(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
  }).format(date);
}

export function StatisticsView({
  cards,
  attempts,
  packs,
  completedDays,
}: StatisticsViewProps) {
  const [visibleMonth, setVisibleMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );

  const activityDates = useMemo(() => {
    const dates = new Set<string>();
    attempts.forEach((attempt) => dates.add(dateKey(attempt.reviewedAt)));
    packs.forEach((pack) => dates.add(dateKey(pack.createdAt)));
    return dates;
  }, [attempts, packs]);

  const calendarDays = useMemo(() => {
    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return [
      ...Array.from({ length: firstWeekday }, () => null),
      ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
    ];
  }, [visibleMonth]);

  const learnedWords = useMemo(() => {
    const words = new Set(cards.map((card) => card.lemma.toLowerCase()));
    packs.forEach((pack) =>
      pack.targetWords.forEach((word) => words.add(word.lemma.toLowerCase())),
    );
    return words.size;
  }, [cards, packs]);

  const learningMinutes = Math.round(
    attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) / 60_000,
  );

  const vocabularyStates = [
    { label: "学习中", value: cards.filter((card) => card.stage === "new" || card.stage === "encountered").length },
    { label: "复习中", value: cards.filter((card) => card.stage === "understood" || card.stage === "recalled").length },
    { label: "已掌握", value: cards.filter((card) => card.stage === "transferred" || card.stage === "stable").length },
    { label: "待复习", value: cards.filter((card) => card.schedule.nextDueAt && new Date(card.schedule.nextDueAt) <= new Date()).length },
  ];

  const recentActivity = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (6 - index));
      const key = dateKey(date);
      const newWords = packs
        .filter((pack) => dateKey(pack.createdAt) === key)
        .reduce((sum, pack) => sum + pack.targetWords.length, 0);
      const reviews = attempts.filter(
        (attempt) => dateKey(attempt.reviewedAt) === key,
      ).length;
      return {
        key,
        label: `${date.getMonth() + 1}.${date.getDate()}`,
        newWords,
        reviews,
      };
    });
  }, [attempts, packs]);

  const chartMaximum = Math.max(
    1,
    ...recentActivity.flatMap((day) => [day.newWords, day.reviews]),
  );

  const changeMonth = (offset: number) => {
    setVisibleMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + offset, 1),
    );
  };

  return (
    <div className="page-view statistics-view">
      <header className="statistics-heading">
        <p className="eyebrow">Statistics / 学习统计</p>
        <h1>每一次学习，都有迹可循。</h1>
        <p className="lede">数据来自本机保存的短文、词卡与复习记录。</p>
      </header>

      <section className="statistics-overview glass-stat-panel">
        <div className="statistics-calendar">
          <div className="calendar-head">
            <h2>{monthLabel(visibleMonth)}</h2>
            <div className="calendar-actions" aria-label="切换月份">
              <button type="button" onClick={() => changeMonth(-1)} aria-label="上个月">←</button>
              <button type="button" onClick={() => changeMonth(1)} aria-label="下个月">→</button>
            </div>
          </div>
          <div className="calendar-grid" aria-label={`${monthLabel(visibleMonth)}学习日历`}>
            {WEEKDAYS.map((weekday) => <strong key={weekday}>{weekday}</strong>)}
            {calendarDays.map((day, index) => {
              if (!day) return <span key={`blank-${index}`} />;
              const key = dateKey(
                new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), day),
              );
              const active = activityDates.has(key);
              return <span className={active ? "has-activity" : ""} key={key}>{day}</span>;
            })}
          </div>
        </div>

        <div className="statistics-totals">
          <div><strong>{Math.max(activityDates.size, completedDays.length)}</strong><span>学习天数</span></div>
          <div><strong>{learningMinutes}</strong><span>累计分钟</span></div>
          <div><strong>{learnedWords}</strong><span>累计学词</span></div>
          <div><strong>{cards.length}</strong><span>在学词卡</span></div>
        </div>
      </section>

      <section className="vocabulary-stats glass-stat-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Vocabulary status</p>
            <h2>词汇掌握状态</h2>
          </div>
          <span className="small muted">共 {cards.length} 张词卡</span>
        </div>
        <div className="vocabulary-state-grid">
          {vocabularyStates.map((state) => (
            <div key={state.label}><strong>{state.value}</strong><span>{state.label}</span></div>
          ))}
        </div>
      </section>

      <section className="activity-chart glass-stat-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Last 7 days</p>
            <h2>近七日学习趋势</h2>
          </div>
          <div className="chart-legend"><span>新词</span><span>复习</span></div>
        </div>
        <div className="bar-chart" aria-label="近七日新词与复习数量柱状图">
          {recentActivity.map((day) => (
            <div className="bar-day" key={day.key}>
              <div className="bar-pair">
                <i style={{ height: `${(day.newWords / chartMaximum) * 100}%` }} title={`新词 ${day.newWords}`} />
                <i style={{ height: `${(day.reviews / chartMaximum) * 100}%` }} title={`复习 ${day.reviews}`} />
              </div>
              <span>{day.label}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
