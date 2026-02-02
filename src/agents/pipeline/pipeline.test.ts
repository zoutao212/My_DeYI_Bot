/**
 * 动态管道单元测试
 */

import { describe, expect, it, beforeEach } from "vitest";
import { IntentAnalyzer } from "./intent-analyzer.js";
import { CapabilityPool, createDefaultCapabilityPool } from "./capability-pool.js";
import { clearAllPipelineStates } from "./plugin.js";
import type { PipelineContext } from "./types.js";
import type { ClawdbotConfig } from "../../config/config.js";

describe("IntentAnalyzer", () => {
  const config = { agents: { dynamicPipeline: { enabled: true } } } as unknown as ClawdbotConfig;

  beforeEach(() => {
    clearAllPipelineStates();
  });

  it("should detect character name from user message", async () => {
    const analyzer = new IntentAnalyzer({ config });
    const context: PipelineContext = {
      userMessage: "丽丝，我回来了",
      conversationHistory: [],
      sessionId: "test-session",
      agentId: "test-agent",
      config,
    };

    const result = await analyzer.analyze({
      userMessage: context.userMessage,
      context,
      capabilities: [],
    });

    expect(result.detectedCharacter).toBeDefined();
    expect(result.detectedCharacter?.id).toBe("lisi");
    expect(result.detectedCharacter?.matchType).toBe("name");
    expect(result.detectedCharacter?.isSystemPersona).toBe(false);
  });

  it("should detect system persona from user message", async () => {
    const analyzer = new IntentAnalyzer({ config });
    const context: PipelineContext = {
      userMessage: "栗娜，帮我安排一下日程",
      conversationHistory: [],
      sessionId: "test-session",
      agentId: "test-agent",
      config,
    };

    const result = await analyzer.analyze({
      userMessage: context.userMessage,
      context,
      capabilities: [],
    });

    expect(result.detectedCharacter).toBeDefined();
    expect(result.detectedCharacter?.id).toBe("lina");
    expect(result.detectedCharacter?.matchType).toBe("name");
    expect(result.detectedCharacter?.isSystemPersona).toBe(true);
  });

  it("should detect system persona from trigger words", async () => {
    const analyzer = new IntentAnalyzer({ config });
    const context: PipelineContext = {
      userMessage: "帮我安排一下明天的日程",
      conversationHistory: [],
      sessionId: "test-session",
      agentId: "test-agent",
      config,
    };

    const result = await analyzer.analyze({
      userMessage: context.userMessage,
      context,
      capabilities: [],
    });

    expect(result.detectedCharacter).toBeDefined();
    expect(result.detectedCharacter?.id).toBe("lina");
    expect(result.detectedCharacter?.matchType).toBe("trigger");
    expect(result.detectedCharacter?.isSystemPersona).toBe(true);
  });

  it("should use default system persona when no character detected", async () => {
    const analyzer = new IntentAnalyzer({ config });
    const context: PipelineContext = {
      userMessage: "你好，今天天气怎么样？",
      conversationHistory: [],
      sessionId: "test-session",
      agentId: "test-agent",
      config,
    };

    const result = await analyzer.analyze({
      userMessage: context.userMessage,
      context,
      capabilities: [],
    });

    expect(result.detectedCharacter).toBeDefined();
    expect(result.detectedCharacter?.id).toBe("lina");
    expect(result.detectedCharacter?.matchType).toBe("default");
    expect(result.detectedCharacter?.isSystemPersona).toBe(true);
  });

  it("should generate execution plan with capabilities", async () => {
    const analyzer = new IntentAnalyzer({ config });
    const capabilities = [
      {
        name: "memory_retriever",
        description: "检索记忆",
        useCases: [],
        parameters: {},
      },
      {
        name: "personality_loader",
        description: "加载人格",
        useCases: [],
        parameters: {},
      },
      {
        name: "memory_archiver",
        description: "归档记忆",
        useCases: [],
        parameters: {},
      },
    ];

    const context: PipelineContext = {
      userMessage: "丽丝，我回来了",
      conversationHistory: [],
      sessionId: "test-session",
      agentId: "test-agent",
      config,
    };

    const result = await analyzer.analyze({
      userMessage: context.userMessage,
      context,
      capabilities,
    });

    expect(result.plan.pipeline.preProcess.length).toBeGreaterThan(0);
    expect(result.plan.pipeline.postProcess.length).toBeGreaterThan(0);

    const preProcessNames = result.plan.pipeline.preProcess.map((c) => c.capability);
    expect(preProcessNames).toContain("memory_retriever");
    expect(preProcessNames).toContain("personality_loader");

    const postProcessNames = result.plan.pipeline.postProcess.map((c) => c.capability);
    expect(postProcessNames).toContain("memory_archiver");
  });
});

describe("CapabilityPool", () => {
  it("should register and retrieve capabilities", () => {
    const pool = new CapabilityPool();
    pool.register({
      name: "test_capability",
      description: "Test capability",
      useCases: ["testing"],
      parameters: {},
      execute: async () => ({ result: "test" }),
    });

    expect(pool.get("test_capability")).toBeDefined();
    expect(pool.get("nonexistent")).toBeUndefined();
  });

  it("should provide capability descriptions for LLM", () => {
    const pool = new CapabilityPool();
    pool.register({
      name: "test_capability",
      description: "Test capability description",
      useCases: ["use case 1", "use case 2"],
      parameters: { param1: "string" },
      execute: async () => ({}),
    });

    const descriptions = pool.getDescriptions();
    expect(descriptions.length).toBe(1);
    expect(descriptions[0]).toEqual({
      name: "test_capability",
      description: "Test capability description",
      useCases: ["use case 1", "use case 2"],
      parameters: { param1: "string" },
    });
  });

  it("should execute capability with params", async () => {
    const pool = new CapabilityPool();
    let receivedParams: Record<string, unknown> | null = null;

    pool.register({
      name: "test_capability",
      description: "Test",
      useCases: [],
      parameters: {},
      execute: async (execParams) => {
        receivedParams = execParams.params;
        return { executed: true };
      },
    });

    const context: PipelineContext = {
      userMessage: "test",
      conversationHistory: [],
      sessionId: "test",
      agentId: "test",
      config: {} as ClawdbotConfig,
    };

    const result = await pool.execute("test_capability", {
      params: { key: "value" },
      context,
      previousResults: {},
    });

    expect(result).toEqual({ executed: true });
    expect(receivedParams).toEqual({ key: "value" });
  });
});

describe("createDefaultCapabilityPool", () => {
  it("should create pool with default capabilities", () => {
    const config = {} as ClawdbotConfig;
    const pool = createDefaultCapabilityPool({
      agentId: "test",
      sessionId: "test",
      config,
    });

    const names = pool.getCapabilityNames();
    expect(names).toContain("personality_loader");
    expect(names).toContain("session_summarizer");
    expect(names).toContain("key_content_extractor");
    expect(names).toContain("relationship_updater");
  });
});

