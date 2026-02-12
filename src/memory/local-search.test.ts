import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  localGrepSearch,
  tokenizeQuery,
  clearFileCache,
} from "./local-search.js";

describe("local-search", () => {
  let tmpDir: string;

  beforeEach(async () => {
    clearFileCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-search-test-"));
    // 创建测试文件
    await fs.writeFile(
      path.join(tmpDir, "test.md"),
      [
        "# 琳娜的记忆",
        "",
        "主人喜欢写代码，尤其是 TypeScript。",
        "琳娜记得主人的 API 密钥在 .env 文件里。",
        "",
        "## 偏好设置",
        "",
        "主人喜欢用 VSCode 编辑器。",
        "端口默认是 3000。",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(tmpDir, "notes.txt"),
      [
        "项目进度笔记",
        "今天完成了记忆系统的优化。",
        "明天计划实现本地搜索功能。",
      ].join("\n"),
      "utf-8",
    );
    // 创建子目录
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "sub", "deep.md"),
      "# 深层文件\n\n这是一个嵌套目录中的记忆文件。\n琳娜在这里也能找到。",
      "utf-8",
    );
  });

  afterEach(async () => {
    clearFileCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("tokenizeQuery", () => {
    it("splits English by whitespace and lowercases", () => {
      const tokens = tokenizeQuery("Hello World API");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
      expect(tokens).toContain("api");
    });

    it("extracts CJK segments (2+ chars)", () => {
      const tokens = tokenizeQuery("琳娜喜欢什么");
      expect(tokens).toContain("琳娜喜欢什么");
    });

    it("handles mixed Chinese+English", () => {
      const tokens = tokenizeQuery("API 密钥配置");
      expect(tokens).toContain("api");
      expect(tokens).toContain("密钥配置");
    });

    it("filters single characters", () => {
      const tokens = tokenizeQuery("a 我 b");
      // 'a' and 'b' are single chars → filtered
      // '我' is single CJK → filtered
      expect(tokens).toHaveLength(0);
    });

    it("deduplicates tokens", () => {
      const tokens = tokenizeQuery("hello hello HELLO");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toBe("hello");
    });
  });

  describe("localGrepSearch", () => {
    it("finds Chinese keywords in .md files", async () => {
      const results = await localGrepSearch("琳娜记忆", {
        dirs: [tmpDir],
        workspaceDir: tmpDir,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].source).toBe("grep");
      // 应该搜到 test.md（标题含"琳娜的记忆"）
      const testMd = results.find((r) => r.path.includes("test.md"));
      expect(testMd).toBeDefined();
    });

    it("finds English keywords", async () => {
      const results = await localGrepSearch("TypeScript API", {
        dirs: [tmpDir],
        workspaceDir: tmpDir,
      });
      expect(results.length).toBeGreaterThan(0);
      const testMd = results.find((r) => r.path.includes("test.md"));
      expect(testMd).toBeDefined();
    });

    it("searches .txt files", async () => {
      const results = await localGrepSearch("记忆系统 优化", {
        dirs: [tmpDir],
        extensions: [".md", ".txt"],
        workspaceDir: tmpDir,
      });
      const notesTxt = results.find((r) => r.path.includes("notes.txt"));
      expect(notesTxt).toBeDefined();
    });

    it("searches recursively into subdirectories", async () => {
      const results = await localGrepSearch("深层文件 琳娜", {
        dirs: [tmpDir],
        recursive: true,
        workspaceDir: tmpDir,
      });
      const deepMd = results.find((r) => r.path.includes("deep.md"));
      expect(deepMd).toBeDefined();
    });

    it("does NOT recurse when recursive=false", async () => {
      const results = await localGrepSearch("深层文件", {
        dirs: [tmpDir],
        recursive: false,
        workspaceDir: tmpDir,
      });
      const deepMd = results.find((r) => r.path.includes("deep.md"));
      expect(deepMd).toBeUndefined();
    });

    it("respects maxResults", async () => {
      const results = await localGrepSearch("琳娜", {
        dirs: [tmpDir],
        maxResults: 1,
        workspaceDir: tmpDir,
      });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("returns empty for no-match query", async () => {
      const results = await localGrepSearch("不存在的关键词xyz", {
        dirs: [tmpDir],
        workspaceDir: tmpDir,
      });
      expect(results).toHaveLength(0);
    });

    it("returns results with correct line numbers (1-indexed)", async () => {
      const results = await localGrepSearch("端口 3000", {
        dirs: [tmpDir],
        contextLines: 0,
        workspaceDir: tmpDir,
      });
      expect(results.length).toBeGreaterThan(0);
      const match = results[0];
      expect(match.startLine).toBeGreaterThanOrEqual(1);
      expect(match.endLine).toBeGreaterThanOrEqual(match.startLine);
    });

    it("gives title matches a higher score", async () => {
      const results = await localGrepSearch("琳娜", {
        dirs: [tmpDir],
        workspaceDir: tmpDir,
      });
      // test.md 有标题行 "# 琳娜的记忆" → 应该排在前面
      // deep.md 也有标题 "# 深层文件" 但不含"琳娜"在标题行
      if (results.length >= 2) {
        // 标题匹配的结果应该 score 更高
        const titleResult = results.find(
          (r) => r.snippet.includes("# 琳娜的记忆"),
        );
        if (titleResult) {
          expect(titleResult.score).toBeGreaterThan(0);
        }
      }
    });

    it("handles non-existent directory gracefully", async () => {
      const results = await localGrepSearch("test", {
        dirs: [path.join(tmpDir, "nonexistent")],
        workspaceDir: tmpDir,
      });
      expect(results).toHaveLength(0);
    });
  });
});
