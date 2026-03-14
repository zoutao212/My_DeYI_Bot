import { extractKeywords } from "../memory/keyword-extractor.js";
import type { ChapterSplit } from "./types.js";

const DEFAULT_CHAPTER_TITLE_RE = /(?:^\s*#{1,3}\s|^第[一二三四五六七八九十百千\d]+[章节篇回幕卷集部]|^Chapter\s+\d|^CHAPTER\s+\d)/i;
const PARA_SPLIT_RE = /\n\s*\n/;
const DEFAULT_TARGET_CHUNK_CHARS = 3000;
const DEFAULT_MAX_CHAPTER_CHARS = 6000;
const DEFAULT_MICRO_CHUNK_CHARS = 300;
const MAX_TITLE_CHARS = 48;
const MAX_TITLE_FALLBACK_CHARS = 60;

function normalizeTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "(无标题章节)";
  return trimmed.replace(/^#{1,6}\s+/, "");
}

function looksLikeBodyUsedAsTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t.includes("\n")) return true;
  if (t.length >= 90) return true;
  const commaCount = (t.match(/[，,]/g) ?? []).length;
  const dotCount = (t.match(/[。！？!?…]/g) ?? []).length;
  if (commaCount >= 3) return true;
  if (dotCount >= 2) return true;
  return false;
}

function shrinkTitleFromPrefix(title: string): string {
  const t = title.trim();
  if (!t) return "";
  const m1 = t.match(/^(第[一二三四五六七八九十百千\d]+[章节篇回幕卷集部])\s*[、,:：\-—]*\s*([^，。！？!?…]{0,20})/);
  if (m1) {
    const head = m1[1] ?? "";
    const tail = (m1[2] ?? "").trim();
    return tail ? `${head} ${tail}`.trim() : head;
  }
  // 兜底：取第一段到逗号/句号前
  const cut = t.split(/[，,。！？!?…]/)[0] ?? t;
  return cut.trim();
}

function clampTitle(title: string, maxChars: number): string {
  const t = title.trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trim();
}

function sanitizeTitle(params: { title: string; textForFallback: string }): string {
  const normalized = normalizeTitle(params.title);
  const t = normalized.trim();
  const isOnlyChapterNumber = /^(第[一二三四五六七八九十百千\d]+[章节篇回幕卷集部]|Chapter\s+\d+|CHAPTER\s+\d+)\s*[、,:：\-—]*$/i.test(t);

  if (t === "(无标题章节)" || t === "" || isOnlyChapterNumber) {
    return clampTitle(fallbackTitleFromKeywords(params.textForFallback), MAX_TITLE_FALLBACK_CHARS) || "(无标题章节)";
  }

  // 过长/像正文：提取前缀短标题，否则回退关键词标题
  if (t.length > MAX_TITLE_CHARS || looksLikeBodyUsedAsTitle(t)) {
    const shortFromPrefix = clampTitle(shrinkTitleFromPrefix(t), MAX_TITLE_CHARS);
    if (shortFromPrefix && !looksLikeBodyUsedAsTitle(shortFromPrefix)) return shortFromPrefix;
    return clampTitle(fallbackTitleFromKeywords(params.textForFallback), MAX_TITLE_FALLBACK_CHARS) || "(无标题章节)";
  }

  return clampTitle(t, MAX_TITLE_CHARS) || "(无标题章节)";
}

function maybeJoinBrokenTitleLine(lines: string[], titleLineIndex: number): string {
  const cur = (lines[titleLineIndex] ?? "").trim();
  const next = (lines[titleLineIndex + 1] ?? "").trim();
  if (!cur) return cur;
  if (!next) return cur;

  const normalized = normalizeTitle(cur);

  const isHalfTitle = /[、,:：\-—]$/.test(normalized) || normalized.length <= 6;
  const nextLooksLikeTitle = DEFAULT_CHAPTER_TITLE_RE.test(next);
  const nextLooksLikeBody = next.length > 0 && next.length <= 40 && !nextLooksLikeTitle;

  if (isHalfTitle && nextLooksLikeBody) {
    return `${normalized}${next}`;
  }
  return normalized;
}

function splitLongTextIntoChunks(params: {
  text: string;
  targetChars: number;
  minChunkChars: number;
}): string[] {
  const targetChars = Math.max(2000, params.targetChars);
  const minChunkChars = Math.max(800, Math.min(params.minChunkChars, targetChars));

  const rawParas = params.text.split(PARA_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  if (rawParas.length <= 1) {
    const t = params.text.trim();
    if (!t) return [];
    if (t.length <= targetChars * 1.2) return [t];
    const chunks: string[] = [];
    for (let i = 0; i < t.length; i += targetChars) {
      chunks.push(t.slice(i, i + targetChars));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufChars = 0;

  const flush = () => {
    const joined = buf.join("\n\n").trim();
    if (!joined) return;
    chunks.push(joined);
    buf = [];
    bufChars = 0;
  };

  for (const para of rawParas) {
    if (bufChars + para.length + 2 <= targetChars || bufChars < minChunkChars) {
      buf.push(para);
      bufChars += para.length + 2;
      continue;
    }
    flush();
    buf.push(para);
    bufChars = para.length;
  }
  flush();

  return chunks;
}

function splitIntoMicroChunks(params: {
  text: string;
  microChars: number;
}): string[] {
  const microChars = Math.max(120, params.microChars);
  const t = params.text.trim();
  if (!t) return [];
  if (t.length <= microChars * 1.15) return [t];

  const pieces: string[] = [];

  const hardCut = (str: string) => {
    const s = str.trim();
    if (!s) return;
    for (let i = 0; i < s.length; i += microChars) {
      const seg = s.slice(i, i + microChars).trim();
      if (seg) pieces.push(seg);
    }
  };

  // 先按句子边界切分，避免出现“指。”这种碎片
  const sentences: string[] = [];
  let buf = "";
  const pushBuf = () => {
    const s = buf.trim();
    buf = "";
    if (s) sentences.push(s);
  };

  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i] ?? "";
    buf += ch;
    const isNewline = ch === "\n";
    const isPunc = /[。！？!?…]/.test(ch);
    if (isNewline || isPunc) {
      pushBuf();
    }
  }
  pushBuf();

  // 聚合句子到 microChars 左右（并确保最小长度）
  const minChars = Math.max(80, Math.floor(microChars * 0.55));
  let chunk = "";
  const flushChunk = () => {
    const s = chunk.trim();
    chunk = "";
    if (s) pieces.push(s);
  };

  for (const sent of sentences) {
    const s = sent.trim();
    if (!s) continue;
    if (s.length > microChars * 1.35) {
      // 超长句子：先把当前 chunk 输出，再硬截断该句
      if (chunk.trim()) flushChunk();
      hardCut(s);
      continue;
    }

    if (!chunk) {
      chunk = s;
      continue;
    }

    if (chunk.length + 1 + s.length <= microChars || chunk.length < minChars) {
      chunk = `${chunk}\n${s}`;
      continue;
    }

    flushChunk();
    chunk = s;
  }
  flushChunk();

  // 二次修复：把过短尾块合并到前一块
  if (pieces.length >= 2) {
    const last = pieces[pieces.length - 1] ?? "";
    if (last.trim().length > 0 && last.trim().length < minChars) {
      const prev = pieces[pieces.length - 2] ?? "";
      pieces.splice(pieces.length - 2, 2, `${prev}\n${last}`.trim());
    }
  }

  // 最后兜底：如果聚合结果仍然出现极短碎片，则回退硬切
  const tooShort = pieces.some((p) => p.trim().length > 0 && p.trim().length < 20);
  if (tooShort) {
    return t.length > 0 ? ((): string[] => {
      const out: string[] = [];
      for (let i = 0; i < t.length; i += microChars) {
        const seg = t.slice(i, i + microChars).trim();
        if (seg) out.push(seg);
      }
      return out;
    })() : [];
  }

  return pieces;
}

function fallbackTitleFromKeywords(text: string): string {
  const keywords = extractKeywords(text, { maxKeywords: 5 });
  const top = keywords
    .map((k) => k.term)
    .filter(Boolean)
    .slice(0, 3);
  if (top.length === 0) return "(无标题章节)";
  return top.join(" · ");
}

export function splitChaptersFromTxt(params: {
  content: string;
  chapterTitleRe?: RegExp;
  minChapterChars?: number;
  maxChapterChars?: number;
  targetChunkChars?: number;
  microChunkChars?: number;
  enableMicroChunks?: boolean;
}): ChapterSplit[] {
  const chapterTitleRe = params.chapterTitleRe ?? DEFAULT_CHAPTER_TITLE_RE;
  const minChapterChars = Math.max(200, params.minChapterChars ?? 800);
  const maxChapterChars = Math.max(minChapterChars * 2, params.maxChapterChars ?? DEFAULT_MAX_CHAPTER_CHARS);
  const targetChunkChars = Math.max(2000, params.targetChunkChars ?? DEFAULT_TARGET_CHUNK_CHARS);
  const enableMicroChunks = Boolean(params.enableMicroChunks ?? false);
  const microChunkChars = Math.max(120, params.microChunkChars ?? DEFAULT_MICRO_CHUNK_CHARS);

  const lines = params.content.split("\n");
  const titleLineIndexes: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (chapterTitleRe.test(line.trim())) {
      titleLineIndexes.push(i);
    }
  }

  const splits: ChapterSplit[] = [];

  if (titleLineIndexes.length === 0) {
    const fullText = params.content.trim();
    const chunks = splitLongTextIntoChunks({
      text: fullText,
      targetChars: targetChunkChars,
      minChunkChars: Math.floor(targetChunkChars * 0.6),
    });
    const baseTitle = fallbackTitleFromKeywords(fullText);
    const effectiveChunks = chunks.length > 0 ? chunks : [fullText];
    const total = Math.max(1, effectiveChunks.length);
    for (let i = 0; i < effectiveChunks.length; i += 1) {
      const macro = effectiveChunks[i] ?? "";
      const macroTitle = total > 1 ? `${baseTitle}（片段${i + 1}/${total}）` : baseTitle;
      if (enableMicroChunks) {
        const micros = splitIntoMicroChunks({ text: macro, microChars: microChunkChars });
        const mTotal = Math.max(1, micros.length);
        for (let m = 0; m < micros.length; m += 1) {
          const micro = micros[m] ?? "";
          const t = mTotal > 1 ? `${macroTitle}·${m + 1}/${mTotal}` : macroTitle;
          splits.push({
            index: splits.length + 1,
            title: t,
            text: micro,
            startLine: 1,
            endLine: lines.length,
            charCount: micro.length,
          });
        }
      } else {
        splits.push({
          index: splits.length + 1,
          title: macroTitle,
          text: macro,
          startLine: 1,
          endLine: lines.length,
          charCount: macro.length,
        });
      }
    }
    return splits;
  }

  const boundaries = [...titleLineIndexes, lines.length];
  for (let t = 0; t < titleLineIndexes.length; t += 1) {
    const startIdx = boundaries[t] ?? 0;
    const endIdx = boundaries[t + 1] ?? lines.length;

    const titleRaw = lines[startIdx] ?? "";
    const chapterLines = lines.slice(startIdx, endIdx);
    const chapterText = chapterLines.join("\n").trim();

    if (chapterText.length < minChapterChars) {
      const prev = splits[splits.length - 1];
      if (prev) {
        prev.text = `${prev.text}\n\n${chapterText}`.trim();
        prev.endLine = endIdx;
        prev.charCount = prev.text.length;
        continue;
      }
    }

    const title = maybeJoinBrokenTitleLine(lines, startIdx);

    if (chapterText.length > maxChapterChars) {
      const chunks = splitLongTextIntoChunks({
        text: chapterText,
        targetChars: targetChunkChars,
        minChunkChars: Math.floor(targetChunkChars * 0.6),
      });
      const total = Math.max(1, chunks.length);
      for (let i = 0; i < chunks.length; i += 1) {
        const macro = chunks[i] ?? "";
        const macroTitleRaw = total > 1 ? `${title}（片段${i + 1}/${total}）` : title;
        const macroTitle = sanitizeTitle({ title: macroTitleRaw, textForFallback: macro });
        if (enableMicroChunks) {
          const micros = splitIntoMicroChunks({ text: macro, microChars: microChunkChars });
          const mTotal = Math.max(1, micros.length);
          for (let m = 0; m < micros.length; m += 1) {
            const micro = micros[m] ?? "";
            const microTitleRaw = mTotal > 1 ? `${macroTitle}·${m + 1}/${mTotal}` : macroTitle;
            const t = sanitizeTitle({ title: microTitleRaw, textForFallback: micro });
            splits.push({
              index: splits.length + 1,
              title: t,
              text: micro,
              startLine: startIdx + 1,
              endLine: endIdx,
              charCount: micro.length,
            });
          }
        } else {
          splits.push({
            index: splits.length + 1,
            title: macroTitle,
            text: macro,
            startLine: startIdx + 1,
            endLine: endIdx,
            charCount: macro.length,
          });
        }
      }
      continue;
    }

    const safeTitle = sanitizeTitle({ title, textForFallback: chapterText });
    splits.push({
      index: splits.length + 1,
      title: safeTitle,
      text: chapterText,
      startLine: startIdx + 1,
      endLine: endIdx,
      charCount: chapterText.length,
    });
  }

  for (const split of splits) {
    split.title = sanitizeTitle({ title: split.title, textForFallback: split.text });
  }

  return splits;
}
