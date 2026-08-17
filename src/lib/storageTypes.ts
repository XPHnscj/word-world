import type { ContextPack, ReviewAttempt, StudySession, UserWordbook, WordCard } from "./types";

export type PersistedKnownWord = { lemma: string; markedAt: string };
export type StorageSnapshot = {
  cards: WordCard[];
  packs: ContextPack[];
  attempts: ReviewAttempt[];
  known: PersistedKnownWord[];
  wordbooks: UserWordbook[];
  sessions: StudySession[];
};
