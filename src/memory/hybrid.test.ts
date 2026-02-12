import { describe, expect, it } from "vitest";

import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins (English)", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("buildFtsQuery handles Chinese via bigram (CJK)", () => {
    // 纯中文：2字 bigram + 完整片段（>2字时）
    const result = buildFtsQuery("琳娜喜欢什么");
    expect(result).not.toBeNull();
    // "琳娜喜欢什么" → bigrams: 琳娜, 娜喜, 喜欢, 欢什, 什么 + 完整: 琳娜喜欢什么
    expect(result).toContain('"琳娜"');
    expect(result).toContain('"喜欢"');
    expect(result).toContain('"什么"');
    // CJK tokens 之间用 OR 连接
    expect(result).toContain(" OR ");
    expect(result).not.toContain(" AND ");
  });

  it("buildFtsQuery handles mixed Chinese+English", () => {
    const result = buildFtsQuery("API 密钥配置");
    expect(result).not.toBeNull();
    // 英文 AND 组 + CJK OR 组
    expect(result).toContain('"API"');
    expect(result).toContain('"密钥"');
    expect(result).toContain('"配置"');
  });

  it("buildFtsQuery returns null for single CJK character", () => {
    // 单字中文噪音太大，不生成 token
    expect(buildFtsQuery("我")).toBeNull();
  });

  it("buildFtsQuery handles 2-char CJK without duplication", () => {
    const result = buildFtsQuery("记忆");
    expect(result).not.toBeNull();
    // 2字片段只有一个 bigram "记忆"，不重复加完整片段
    expect(result).toBe('"记忆"');
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1);
  });

  it("mergeHybridResults unions by id and combines weighted scores", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(b?.score).toBeCloseTo(0.3 * 1.0);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1.0);
  });
});
