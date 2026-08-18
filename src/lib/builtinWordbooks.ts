export type BuiltinWordbookCategory = "domestic-exam" | "international-exam";

export interface BuiltinWordbookDefinition {
  id: string;
  name: string;
  shortName: string;
  category: BuiltinWordbookCategory;
  categoryLabel: string;
  wordCount: number;
  sourcePath: string;
  sourceLabel: string;
}

/**
 * 首批内置词书目录。每本词书只保留一个逻辑 ID；资料版本和学习顺序
 * 后续可以在同一条目录记录上扩展，不在词书架上制造重复卡片。
 */
export const BUILTIN_WORDBOOKS: BuiltinWordbookDefinition[] = [
  {
    id: "builtin-cet4",
    name: "大学英语四级",
    shortName: "四级",
    category: "domestic-exam",
    categoryLabel: "国内考试",
    wordCount: 7508,
    sourcePath: "wordbooks/kylebing/simple/ordered/cet4.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-cet6",
    name: "大学英语六级",
    shortName: "六级",
    category: "domestic-exam",
    categoryLabel: "国内考试",
    wordCount: 5651,
    sourcePath: "wordbooks/kylebing/simple/ordered/cet6.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-tem4",
    name: "英语专业四级",
    shortName: "专四",
    category: "domestic-exam",
    categoryLabel: "国内考试",
    wordCount: 4620,
    sourcePath: "wordbooks/kylebing/simple/ordered/tem4.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-tem8",
    name: "英语专业八级",
    shortName: "专八",
    category: "domestic-exam",
    categoryLabel: "国内考试",
    wordCount: 12881,
    sourcePath: "wordbooks/kylebing/simple/ordered/tem8.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-postgraduate",
    name: "考研英语",
    shortName: "考研",
    category: "domestic-exam",
    categoryLabel: "国内考试",
    wordCount: 9602,
    sourcePath: "wordbooks/kylebing/simple/ordered/postgraduate.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-ielts",
    name: "雅思",
    shortName: "IELTS",
    category: "international-exam",
    categoryLabel: "国际考试",
    wordCount: 7002,
    sourcePath: "wordbooks/kylebing/simple/ordered/ielts.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-toefl",
    name: "托福",
    shortName: "TOEFL",
    category: "international-exam",
    categoryLabel: "国际考试",
    wordCount: 13477,
    sourcePath: "wordbooks/kylebing/simple/ordered/toefl.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-sat",
    name: "SAT",
    shortName: "SAT",
    category: "international-exam",
    categoryLabel: "国际考试",
    wordCount: 8887,
    sourcePath: "wordbooks/kylebing/simple/ordered/sat.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-gre",
    name: "GRE",
    shortName: "GRE",
    category: "international-exam",
    categoryLabel: "国际考试",
    wordCount: 13714,
    sourcePath: "wordbooks/kylebing/simple/ordered/gre.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
  {
    id: "builtin-gmat",
    name: "GMAT",
    shortName: "GMAT",
    category: "international-exam",
    categoryLabel: "国际考试",
    wordCount: 6301,
    sourcePath: "wordbooks/kylebing/simple/ordered/gmat.tsv",
    sourceLabel: "KyleBing English Vocabulary · full_line_tsv/simple/正序",
  },
];

export function getBuiltinWordbook(id: string) {
  return BUILTIN_WORDBOOKS.find((book) => book.id === id);
}

export function isBuiltinWordbookId(id: string) {
  return Boolean(getBuiltinWordbook(id));
}

