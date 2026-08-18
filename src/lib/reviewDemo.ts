import type { ContextPack, WordCard } from "./types";

type DemoWord = {
  lemma: string;
  definitionEn: string;
  meaningZh: string;
  partOfSpeech: string;
  collocation: string;
  sentence: string;
  translation: string;
};

const DEMO_WORDS: DemoWord[] = [
  { lemma: "flash", definitionEn: "a sudden burst of light", meaningZh: "闪光；突然出现", partOfSpeech: "n.", collocation: "a flash of inspiration", sentence: "A flash lit the camera lens in the quiet studio.", translation: "一道闪光照亮了安静工作室里的相机镜头。" },
  { lemma: "allocate", definitionEn: "to distribute resources for a particular purpose", meaningZh: "分配；拨给", partOfSpeech: "v.", collocation: "allocate funds", sentence: "The city decided to allocate funds to a public garden.", translation: "城市决定为一座公共花园分配资金。" },
  { lemma: "resilient", definitionEn: "able to recover quickly from difficulty", meaningZh: "有韧性的；能迅速恢复的", partOfSpeech: "adj.", collocation: "a resilient community", sentence: "The resilient community rebuilt its market after the storm.", translation: "暴风雨后，这个有韧性的社区重建了市场。" },
  { lemma: "sustainable", definitionEn: "able to continue without harming the future", meaningZh: "可持续的", partOfSpeech: "adj.", collocation: "sustainable development", sentence: "The school adopted a sustainable design for its new building.", translation: "学校为新楼采用了可持续的设计。" },
  { lemma: "evidence", definitionEn: "facts or information that show something is true", meaningZh: "证据；依据", partOfSpeech: "n.", collocation: "strong evidence", sentence: "The researcher found strong evidence in the final report.", translation: "研究人员在最终报告中找到了有力证据。" },
  { lemma: "maintain", definitionEn: "to keep something in good condition or at the same level", meaningZh: "维持；维护", partOfSpeech: "v.", collocation: "maintain trust", sentence: "Small gestures helped the team maintain trust during the crisis.", translation: "危机期间，小小的举动帮助团队维持了信任。" },
  { lemma: "adapt", definitionEn: "to change your behavior or approach to fit a new situation", meaningZh: "适应；调整", partOfSpeech: "v.", collocation: "adapt to change", sentence: "The designer had to adapt the plan when the light changed.", translation: "光线变化后，设计师不得不调整计划。" },
  { lemma: "trend", definitionEn: "a general direction in which something is developing", meaningZh: "趋势；动向", partOfSpeech: "n.", collocation: "a growing trend", sentence: "The chart revealed a growing trend toward flexible work.", translation: "图表显示出灵活办公日益增长的趋势。" },
];

function shuffle<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

export function makeReviewDemoBundle(now = new Date()): { cards: WordCard[]; pack: ContextPack } {
  const selected = shuffle(DEMO_WORDS).slice(0, 4);
  const createdAt = now.toISOString();
  const packId = `review_demo_pack_${now.getTime().toString(36)}`;
  const cards = selected.map((word, index): WordCard => ({
    id: `review_demo_${word.lemma}`,
    lemma: word.lemma,
    planDay: 1,
    sourceTitle: "随机复习体验",
    definitionEn: word.definitionEn,
    meaningZh: word.meaningZh,
    partOfSpeech: word.partOfSpeech,
    collocations: [word.collocation],
    packIds: [packId],
    stage: (["encountered", "understood", "recalled", "stable"] as WordCard["stage"][])[index],
    masteryLevel: (index + 1) as WordCard["masteryLevel"],
    schedule: {
      difficulty: 4,
      stability: 1,
      lastReviewedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      nextDueAt: new Date(now.getTime() - 3_600_000).toISOString(),
    },
    correct: index + 1,
    lapses: index === 0 ? 1 : 0,
    hints: 0,
    dimensions: { recognition: 30, recall: 20, collocation: 10, reading: 10, transfer: index * 10 },
    updatedAt: createdAt,
  }));
  const passage = selected.map((word) => word.sentence).join(" ");
  const translation = selected.map((word) => word.translation).join("");
  const pack: ContextPack = {
    id: packId,
    title: "随机复习体验",
    topic: "多场景词汇",
    difficulty: "standard",
    passage,
    translation,
    targetWords: selected.map((word, index) => ({
      lemma: word.lemma,
      surfaceForm: word.lemma,
      meaningZh: word.meaningZh,
      translationZh: word.translation,
      partOfSpeech: word.partOfSpeech,
      collocation: word.collocation,
      sentenceIndex: index,
    })),
    sentenceNotes: [],
    tasks: [],
    qualityReport: { passed: true, score: 4.8, notes: ["随机体验词卡"] },
    planDay: 1,
    generatedBy: "local",
    createdAt,
  };
  return { cards, pack };
}
