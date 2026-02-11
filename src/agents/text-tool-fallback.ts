/**
 * 文本模式工具回退（ReAct 模式）
 *
 * 当 API 代理不支持 function calling 时，自动降级到文本模式：
 * - 将工具参数定义注入 system prompt（文本描述 + 调用格式说明）
 * - LLM 使用 ```tool 代码块输出工具调用意图
 * - 系统解析并执行工具调用，将结果注入下一轮对话
 *
 * 调用链：
 *   attempt.ts → isDegradedProvider() → 如果是 → buildTextToolPrompt() 注入 system prompt
 *   attempt.ts → prompt() 返回后 → parseTextToolCalls() → executeTextToolCalls()
 *             → formatToolResultsPrompt() → 再次 prompt() → 循环直到无工具调用
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";

// ─── 常量 ──────────────────────────────────────────────────

/** 单次 prompt 中最多执行的文本工具调用轮次 */
export const MAX_TEXT_TOOL_ITERATIONS = 15;

/** 单轮中最多执行的工具调用数量 */
const MAX_CALLS_PER_ITERATION = 5;

/** 工具结果最大长度（字符），超出截断 */
const MAX_RESULT_LENGTH = 15000;

// ─── 降级 Provider 追踪 ──────────────────────────────────────

// key: "provider::model" → { timestamp, consecutiveCount }
const degradedProviders = new Map<string, { ts: number; count: number }>();

function providerKey(provider: string, model: string): string {
  return `${provider.toLowerCase().trim()}::${model.toLowerCase().trim()}`;
}

/**
 * 检查 provider+model 是否已被标记为降级（不支持 function calling）
 */
export function isDegradedProvider(provider: string, model: string): boolean {
  return degradedProviders.has(providerKey(provider, model));
}

/**
 * 标记 provider+model 为降级模式
 */
export function markDegradedProvider(provider: string, model: string): void {
  const key = providerKey(provider, model);
  const existing = degradedProviders.get(key);
  if (existing) {
    existing.count += 1;
    existing.ts = Date.now();
  } else {
    degradedProviders.set(key, { ts: Date.now(), count: 1 });
    console.log(
      `[text-tool-fallback] ⚠️ 标记降级 provider: ${provider}/${model} ` +
        `(不支持 function calling，已切换到文本模式)`,
    );
  }
}

/**
 * 清除降级标记（例如成功的 function calling 证明 provider 恢复了）
 */
export function clearDegradedProvider(provider: string, model: string): void {
  const key = providerKey(provider, model);
  if (degradedProviders.delete(key)) {
    console.log(
      `[text-tool-fallback] ✅ 清除降级标记: ${provider}/${model} (function calling 已恢复)`,
    );
  }
}

/**
 * 获取所有降级 provider 的状态快照（用于诊断日志）
 */
export function getDegradedProviderSnapshot(): Array<{
  provider: string;
  model: string;
  since: number;
  count: number;
}> {
  return Array.from(degradedProviders.entries()).map(([key, val]) => {
    const [provider, model] = key.split("::");
    return { provider, model, since: val.ts, count: val.count };
  });
}

// ─── 配置驱动的降级预标记 ──────────────────────────────────

// 已初始化的 config 指纹，避免重复扫描
let _configInitFingerprint = "";

/**
 * 从 ClawdbotConfig 读取所有 provider 的 model 定义，
 * 将 toolCalling === false 的 provider+model 预标记为降级。
 *
 * 幂等：同一份 config 只处理一次（按 activeProviderId+activeModelId 指纹去重）。
 * 应在 attempt.ts Step 3.9 之前调用。
 */
export function initDegradedFromConfig(config: {
  models?: {
    activeProviderId?: string;
    activeModelId?: string;
    providers?: Record<
      string,
      { models: Array<{ id: string; toolCalling?: boolean }> }
    >;
  };
}): void {
  const providers = config?.models?.providers;
  if (!providers) return;

  // 简单指纹：避免每次 attempt 都重复扫描
  const fp = `${config.models?.activeProviderId ?? ""}::${config.models?.activeModelId ?? ""}::${Object.keys(providers).sort().join(",")}`;
  if (fp === _configInitFingerprint) return;
  _configInitFingerprint = fp;

  for (const [providerId, providerCfg] of Object.entries(providers)) {
    if (!providerCfg?.models) continue;
    for (const model of providerCfg.models) {
      if (model.toolCalling === false) {
        // 配置明确声明不支持 tool calling → 直接预标记
        if (!isDegradedProvider(providerId, model.id)) {
          markDegradedProvider(providerId, model.id);
          console.log(
            `[text-tool-fallback] 📋 配置预标记: ${providerId}/${model.id} toolCalling=false`,
          );
        }
      }
    }
  }
}

// ─── 降级检测 ──────────────────────────────────────────────

/**
 * 检测 LLM 响应是否表明 function calling 失效。
 *
 * 判定条件（全部满足才触发）：
 *   1. 工具已注册（不是 disableTools 模式）
 *   2. LLM 没有发起任何 function call
 *   3. LLM 返回了较长的文本回复（>200字符，排除简短对话）
 */
export function shouldDetectDegraded(params: {
  toolsRegistered: boolean;
  hasToolCalls: boolean;
  hasTextResponse: boolean;
  textLength: number;
}): boolean {
  return (
    params.toolsRegistered &&
    !params.hasToolCalls &&
    params.hasTextResponse &&
    params.textLength > 200
  );
}

// ─── 文本模式工具描述生成 ──────────────────────────────────────

type ParamInfo = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enumValues?: string[];
};

/**
 * 从 JSON Schema 提取参数信息
 */
function extractToolParams(schema: unknown): ParamInfo[] {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  if (!properties) return [];

  const required = new Set(
    Array.isArray(record.required) ? (record.required as string[]) : [],
  );

  return Object.entries(properties).map(([name, prop]) => {
    const propRecord = (prop && typeof prop === "object" ? prop : {}) as Record<
      string,
      unknown
    >;
    const enumValues = Array.isArray(propRecord.enum)
      ? (propRecord.enum as string[])
      : undefined;
    return {
      name,
      type: typeof propRecord.type === "string" ? propRecord.type : "any",
      required: required.has(name),
      description:
        typeof propRecord.description === "string"
          ? propRecord.description
          : "",
      enumValues,
    };
  });
}

/**
 * 将工具定义转换为文本描述，注入 system prompt。
 * 包含调用格式说明和详细的参数描述。
 */
export function buildTextToolPrompt(
  tools: Array<{
    name: string;
    description: string;
    parameters?: unknown;
  }>,
): string {
  if (tools.length === 0) return "";

  // 只为核心工具生成详细描述，其他工具只列名称
  const coreToolNames = new Set([
    "read",
    "write",
    "edit",
    "exec",
    "process",
    "enqueue_task",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "send_file",
    "message",
  ]);

  const coreTools: string[] = [];
  const otherToolNames: string[] = [];

  for (const tool of tools) {
    if (coreToolNames.has(tool.name)) {
      const params = extractToolParams(tool.parameters);
      const paramLines = params
        .map((p) => {
          let line = `  - **${p.name}** (${p.type}${p.required ? ", 必需" : ", 可选"}): ${p.description}`;
          if (p.enumValues && p.enumValues.length > 0) {
            line += ` [可选值: ${p.enumValues.join(", ")}]`;
          }
          return line;
        })
        .join("\n");
      coreTools.push(
        `### ${tool.name}\n${tool.description}${paramLines ? `\n参数：\n${paramLines}` : ""}`,
      );
    } else {
      otherToolNames.push(tool.name);
    }
  }

  const otherSection =
    otherToolNames.length > 0
      ? `\n\n### 其他可用工具\n${otherToolNames.join(", ")}\n（调用方式相同，参数详见工具定义）`
      : "";

  return `
## 🔧 工具调用（文本模式）

当前 API 不支持原生函数调用(function calling)，请使用以下文本格式调用工具。

**调用格式**（必须严格遵循）：

\`\`\`tool
{"tool": "工具名称", "args": {"参数1": "值1", "参数2": "值2"}}
\`\`\`

**重要规则**：
1. 每次回复中可包含多个工具调用，每个用单独的 \`\`\`tool 代码块
2. 工具调用后系统会自动执行并返回结果
3. args 必须是合法的 JSON 对象
4. 文件路径使用绝对路径
5. 调用完工具后**等待结果**再继续，不要自行假设结果
6. **禁止**把工具调用放在 \`\`\`python 或 \`\`\`json 代码块中

**核心工具**：

${coreTools.join("\n\n")}${otherSection}
`.trim();
}

// ─── ReAct 解析器 ──────────────────────────────────────────

export type TextToolCall = {
  tool: string;
  args: Record<string, unknown>;
  raw: string;
};

/**
 * 从 LLM 文本响应中提取 ```tool 代码块中的工具调用
 */
export function parseTextToolCalls(text: string): TextToolCall[] {
  const results: TextToolCall[] = [];

  // 主格式：```tool ... ```
  const toolBlockRegex = /```tool\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = toolBlockRegex.exec(text)) !== null) {
    const raw = match[1].trim();
    const parsed = tryParseToolCallJson(raw);
    if (parsed) results.push(parsed);
  }

  // 回退：如果没找到 ```tool 块，尝试 ```json 块中包含 "tool" 字段的
  if (results.length === 0) {
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)```/g;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
      const raw = match[1].trim();
      const parsed = tryParseToolCallJson(raw);
      if (parsed) results.push(parsed);
    }
  }

  // 限制单次解析数量，防止异常
  return results.slice(0, MAX_CALLS_PER_ITERATION);
}

/**
 * 尝试从 JSON 文本解析出工具调用
 */
function tryParseToolCallJson(raw: string): TextToolCall | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.tool === "string" &&
      parsed.tool.trim()
    ) {
      return {
        tool: parsed.tool.trim(),
        args:
          parsed.args && typeof parsed.args === "object" ? parsed.args : {},
        raw,
      };
    }
  } catch {
    // JSON 解析失败
    console.warn(
      `[text-tool-fallback] ⚠️ 无法解析工具调用 JSON: ${raw.slice(0, 200)}`,
    );
  }
  return null;
}

// ─── 工具执行 ──────────────────────────────────────────────

export type TextToolResult = {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
};

/**
 * 执行解析出的文本工具调用。
 * 顺序执行，每个工具调用之间不加延迟。
 */
export async function executeTextToolCalls(
  calls: TextToolCall[],
  tools: AgentTool[],
): Promise<TextToolResult[]> {
  const results: TextToolResult[] = [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  for (const call of calls) {
    const tool = toolMap.get(call.tool);
    const started = Date.now();

    if (!tool) {
      results.push({
        tool: call.tool,
        success: false,
        result: "",
        error: `未知工具: "${call.tool}"（可用工具: ${Array.from(toolMap.keys()).join(", ")}）`,
        durationMs: 0,
      });
      console.warn(
        `[text-tool-fallback] ❌ 未知工具: ${call.tool}`,
      );
      continue;
    }

    try {
      console.log(
        `[text-tool-fallback] 🔧 执行工具: ${call.tool}(${JSON.stringify(call.args).slice(0, 300)})`,
      );
      const result = await (tool as any).execute(call.args);
      const resultStr =
        typeof result === "string"
          ? result
          : result === undefined || result === null
            ? "(无输出)"
            : JSON.stringify(result, null, 2);

      const truncated =
        resultStr.length > MAX_RESULT_LENGTH
          ? resultStr.slice(0, MAX_RESULT_LENGTH) +
            `\n...(结果已截断，共 ${resultStr.length} 字符)`
          : resultStr;

      results.push({
        tool: call.tool,
        success: true,
        result: truncated,
        durationMs: Date.now() - started,
      });
      console.log(
        `[text-tool-fallback] ✅ 工具 ${call.tool} 执行成功 (${Date.now() - started}ms, ` +
          `结果 ${truncated.length} 字符)`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        tool: call.tool,
        success: false,
        result: "",
        error: errorMsg,
        durationMs: Date.now() - started,
      });
      console.warn(
        `[text-tool-fallback] ❌ 工具 ${call.tool} 执行失败 (${Date.now() - started}ms): ${errorMsg}`,
      );
    }
  }

  return results;
}

// ─── 工具结果格式化 ──────────────────────────────────────────

/**
 * 将工具执行结果格式化为 LLM 可理解的文本提示
 */
export function formatToolResultsPrompt(results: TextToolResult[]): string {
  const parts = results.map((r) => {
    if (r.success) {
      return `## 工具 \`${r.tool}\` 执行结果 ✅\n\n${r.result}`;
    }
    return `## 工具 \`${r.tool}\` 执行失败 ❌\n\n错误: ${r.error}`;
  });

  return (
    "[系统消息] 以下是你请求的工具调用的执行结果：\n\n" +
    parts.join("\n\n---\n\n") +
    "\n\n请基于以上结果继续你的任务。如需调用更多工具，请继续使用 ```tool 格式。" +
    "如果任务已完成，直接回复最终结果。"
  );
}
