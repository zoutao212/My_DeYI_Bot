import type { Stats } from "node:fs";

export type TextEtlImportResult = {
  bookId: string;
  bookTitle: string;
  inputPath: string;
  outputDir: string;
  chaptersWritten: number;
  totalChars: number;
};

export type ChapterSplit = {
  index: number;
  title: string;
  text: string;
  startLine: number;
  endLine: number;
  charCount: number;
};

export type TextEtlBookMetaV1 = {
  version: 1;
  bookId: string;
  title: string;
  input: {
    absPath: string;
    size: number;
    mtimeMs: number;
  };
  createdAt: number;
  updatedAt: number;
  chapters: Array<{
    index: number;
    title: string;
    file: string;
    charCount: number;
    startLine: number;
    endLine: number;
  }>;
};

export type BuildBookIdParams = {
  inputAbsPath: string;
  bookTitle: string;
  stat: Stats;
};
