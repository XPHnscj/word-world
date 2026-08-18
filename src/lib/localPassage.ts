type PlanningMode = "topic" | "story";

const replacementWords = [
  "the", "a", "this", "one", "that", "some", "each", "clear", "small", "shared", "daily", "final",
];

function safeReplacement(targets: Set<string>, original: string): string {
  return replacementWords.find((candidate) => candidate !== original.toLowerCase() && !targets.has(candidate)) ?? "another";
}

function sanitizeStaticText(text: string, targets: Set<string>): string {
  return text.replace(/[A-Za-z]+(?:['-][A-Za-z]+)*/g, (token) => {
    const lower = token.toLowerCase();
    return targets.has(lower) ? safeReplacement(targets, lower) : token;
  });
}

/** 本地回退也保持短文紧凑，避免服务不可用时生成一大段重复模板。 */
export function buildLocalPassage(words: string[], planning: PlanningMode = "topic"): string {
  const uniqueWords = [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))];
  if (!uniqueWords.length) {
    return "In a quiet study room, a student reviewed one clear example and wrote a short note for future practice.";
  }

  const targets = new Set(uniqueWords);
  const markers = new Map<string, string>();
  const groups = Array.from({ length: 5 }, () => [] as string[]);
  uniqueWords.forEach((word, index) => groups[index % groups.length].push(word));
  const terms = (group: string[], sentenceIndex: number) => {
    if (!group.length) return "one quiet detail";
    return group
      .map((word, wordIndex) => {
        const marker = `\uE000${sentenceIndex}-${wordIndex}\uE001`;
        markers.set(marker, word);
        return marker;
      })
      .join(group.length > 1 ? " and " : "");
  };
  const sentences = planning === "story"
    ? [
        `In a quiet station room, a student opened a notebook and placed ${terms(groups[0], 0)} beside a timetable.`,
        `As rain tapped the window, the student used ${terms(groups[1], 1)} to describe one practical problem.`,
        `Although ${terms(groups[2], 2)} seemed unrelated, a careful comparison connected the details to the same decision.`,
        `The note then linked ${terms(groups[3], 3)} to a clear reason, so the account became easier to follow.`,
        `By evening, ${terms(groups[4], 4)} had joined one example, leaving the student with a useful pattern for future writing.`,
      ]
    : [
        `In a quiet library room, a student opened a notebook and placed ${terms(groups[0], 0)} beside a policy note.`,
        `As rain tapped the window, the student used ${terms(groups[1], 1)} to describe one practical problem.`,
        `Although ${terms(groups[2], 2)} seemed unrelated, a careful comparison connected the details to the same decision.`,
        `The note then linked ${terms(groups[3], 3)} to a clear reason, so the argument became easier to follow.`,
        `By evening, ${terms(groups[4], 4)} had joined one example, leaving the student with a useful pattern for future writing.`,
      ];

  return sentences
    .map((sentence) => {
      let safeSentence = sanitizeStaticText(sentence, targets);
      for (const [marker, word] of markers) safeSentence = safeSentence.replace(marker, word);
      return safeSentence;
    })
    .join(" ");
}
