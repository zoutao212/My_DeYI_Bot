import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keywordSearch } from "./memory-keyword-search.js";

describe("keywordSearch", () => {
  const testDir = path.join(process.cwd(), "test-memory-keyword-search");

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should find exact keyword matches", async () => {
    await fs.writeFile(
      path.join(testDir, "test.md"),
      "黄蓉是一个聪明的角色\n她擅长厨艺和武功\n郭靖是她的丈夫"
    );

    const results = await keywordSearch({
      query: "黄蓉 角色",
      memoryDir: testDir,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("黄蓉");
    expect(results[0].text).toContain("角色");
  });

  it("should return results sorted by relevance", async () => {
    await fs.writeFile(
      path.join(testDir, "test.md"),
      "黄蓉是一个聪明的角色\n她擅长厨艺\n黄蓉和郭靖是夫妻"
    );

    const results = await keywordSearch({
      query: "黄蓉",
      memoryDir: testDir,
    });

    expect(results.length).toBe(2);
    // 两行都包含"黄蓉"，score 应该相同
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBe(1.0);
  });

  it("should include context lines", async () => {
    await fs.writeFile(
      path.join(testDir, "test.md"),
      "第一行\n黄蓉是主角\n第三行"
    );

    const results = await keywordSearch({
      query: "黄蓉",
      memoryDir: testDir,
    });

    expect(results.length).toBe(1);
    // 应该包含前后各一行的上下文
    expect(results[0].text).toContain("第一行");
    expect(results[0].text).toContain("黄蓉是主角");
    expect(results[0].text).toContain("第三行");
  });

  it("should limit results to maxResults", async () => {
    await fs.writeFile(
      path.join(testDir, "test.md"),
      "黄蓉1\n黄蓉2\n黄蓉3\n黄蓉4\n黄蓉5"
    );

    const results = await keywordSearch({
      query: "黄蓉",
      memoryDir: testDir,
      maxResults: 3,
    });

    expect(results.length).toBe(3);
  });

  it("should handle multiple keywords", async () => {
    await fs.writeFile(
      path.join(testDir, "test.md"),
      "黄蓉是一个聪明的角色\n她擅长厨艺\n郭靖是她的丈夫"
    );

    const results = await keywordSearch({
      query: "黄蓉 厨艺",
      memoryDir: testDir,
    });

    expect(results.length).toBeGreaterThan(0);
    // 包含两个关键词的行应该排在前面
    const topResult = results[0];
    expect(topResult.text.toLowerCase()).toContain("黄蓉");
    expect(topResult.text.toLowerCase()).toContain("厨艺");
  });

  it("should handle empty query", async () => {
    await fs.writeFile(path.join(testDir, "test.md"), "some content");

    const results = await keywordSearch({
      query: "",
      memoryDir: testDir,
    });

    expect(results.length).toBe(0);
  });

  it("should handle non-existent directory", async () => {
    const results = await keywordSearch({
      query: "test",
      memoryDir: path.join(testDir, "non-existent"),
    });

    expect(results.length).toBe(0);
  });

  it("should skip non-markdown files", async () => {
    await fs.writeFile(path.join(testDir, "test.txt"), "黄蓉");
    await fs.writeFile(path.join(testDir, "test.md"), "郭靖");

    const results = await keywordSearch({
      query: "黄蓉",
      memoryDir: testDir,
    });

    expect(results.length).toBe(0); // 应该跳过 .txt 文件
  });

  it("should handle case-insensitive search", async () => {
    await fs.writeFile(path.join(testDir, "test.md"), "HUANG RONG is a character");

    const results = await keywordSearch({
      query: "huang rong",
      memoryDir: testDir,
    });

    expect(results.length).toBeGreaterThan(0);
  });

  it("should filter single-character keywords", async () => {
    await fs.writeFile(path.join(testDir, "test.md"), "黄蓉是一个角色");

    const results = await keywordSearch({
      query: "黄 蓉 是 一 个",
      memoryDir: testDir,
    });

    // 单字符关键词应该被过滤
    expect(results.length).toBe(0);
  });
});
