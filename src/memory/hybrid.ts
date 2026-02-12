export type HybridSource = string;

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

export function buildFtsQuery(raw: string): string | null {
  // 英文/数字 token（保持原有逻辑）
  const alphaTokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];

  // CJK 字符 bigram 切分（中日韩统一表意文字）
  const cjkSegments = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g) ?? [];
  const cjkTokens: string[] = [];
  for (const segment of cjkSegments) {
    // 2字及以上：按 bigram（2字滑动窗口）切分
    if (segment.length >= 2) {
      for (let i = 0; i <= segment.length - 2; i++) {
        cjkTokens.push(segment.substring(i, i + 2));
      }
      // 完整片段也加入（提升精确匹配权重）
      if (segment.length > 2) {
        cjkTokens.push(segment);
      }
    }
    // 单字不加入（噪音太大）
  }

  const allTokens = [...alphaTokens, ...cjkTokens];
  if (allTokens.length === 0) return null;

  const quoted = allTokens.map((t) => `"${t.replaceAll('"', "")}"`);
  // 英文用 AND（精确匹配），CJK bigram 用 OR（部分命中也有价值）
  if (alphaTokens.length > 0 && cjkTokens.length === 0) {
    return quoted.join(" AND ");
  }
  if (alphaTokens.length === 0 && cjkTokens.length > 0) {
    return quoted.join(" OR ");
  }
  // 混合查询：英文 AND 组 + CJK OR 组，两组之间用 OR 连接
  const alphaQuoted = alphaTokens.map((t) => `"${t.replaceAll('"', "")}"`);
  const cjkQuoted = cjkTokens.map((t) => `"${t.replaceAll('"', "")}"`);
  const alphaPart = alphaQuoted.join(" AND ");
  const cjkPart = cjkQuoted.join(" OR ");
  return `(${alphaPart}) OR (${cjkPart})`;
}

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
}): Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
}> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) existing.snippet = r.snippet;
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  return merged.sort((a, b) => b.score - a.score);
}
