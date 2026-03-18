import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LlmApprovalDecision = "allow-once" | "allow-always" | "deny";

export type LlmApprovalRule = {
  id?: string;
  enabled?: boolean;
  provider?: string;
  modelId?: string;
  source?: string;
  sessionKey?: string;
  urlHost?: string;
  urlPathPrefix?: string;
  lastUsedAt?: number;
  lastUsedSummary?: string;
};

export type LlmApprovalsFile = {
  version: 1;
  enabled?: boolean;
  ask?: "off" | "always" | "on-miss";
  rules?: LlmApprovalRule[];
};

export type LlmApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: LlmApprovalsFile;
};

export type LlmApprovalRequestPayload = {
  provider?: string | null;
  modelId?: string | null;
  source?: string | null;
  toolName?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  url: string;
  method?: string | null;
  headers?: Record<string, string> | null;
  bodyText?: string | null;
  bodyJson?: unknown;
  bodySummary?: string | null;
};

export type LlmApprovalRequest = {
  id: string;
  request: LlmApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export function resolveLlmApprovalsPath(): string {
  return path.join(os.homedir(), ".clawdbot", "llm-approvals.json");
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function hashRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function normalizeRule(rule: LlmApprovalRule): LlmApprovalRule {
  const normalize = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    id: rule.id ? String(rule.id) : undefined,
    enabled: rule.enabled !== false,
    provider: normalize(rule.provider) || undefined,
    modelId: normalize(rule.modelId) || undefined,
    source: normalize(rule.source) || undefined,
    sessionKey: normalize(rule.sessionKey) || undefined,
    urlHost: normalize(rule.urlHost).toLowerCase() || undefined,
    urlPathPrefix: normalize(rule.urlPathPrefix) || undefined,
    lastUsedAt: typeof rule.lastUsedAt === "number" ? rule.lastUsedAt : undefined,
    lastUsedSummary: normalize(rule.lastUsedSummary) || undefined,
  };
}

export function normalizeLlmApprovals(file: LlmApprovalsFile): LlmApprovalsFile {
  const rules = Array.isArray(file.rules) ? file.rules.map(normalizeRule) : [];
  const withIds = rules.map((r) => (r.id ? r : { ...r, id: crypto.randomUUID() }));
  return {
    version: 1,
    enabled: file.enabled !== false,
    ask: file.ask === "off" || file.ask === "always" || file.ask === "on-miss" ? file.ask : "always",
    rules: withIds,
  };
}

export function readLlmApprovalsSnapshot(): LlmApprovalsSnapshot {
  const filePath = resolveLlmApprovalsPath();
  if (!fs.existsSync(filePath)) {
    const file = normalizeLlmApprovals({ version: 1, enabled: true, ask: "always", rules: [] });
    return { path: filePath, exists: false, hash: hashRaw(null), file };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: LlmApprovalsFile | null = null;
  try {
    parsed = JSON.parse(raw) as LlmApprovalsFile;
  } catch {
    parsed = null;
  }
  const file =
    parsed?.version === 1
      ? normalizeLlmApprovals(parsed)
      : normalizeLlmApprovals({ version: 1, enabled: true, ask: "always", rules: [] });
  return { path: filePath, exists: true, hash: hashRaw(raw), file };
}

export function loadLlmApprovals(): LlmApprovalsFile {
  return readLlmApprovalsSnapshot().file;
}

export function saveLlmApprovals(file: LlmApprovalsFile) {
  const filePath = resolveLlmApprovalsPath();
  ensureDir(filePath);
  const normalized = normalizeLlmApprovals(file);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function safeUrlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function safeUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function matchLlmRule(params: {
  rule: LlmApprovalRule;
  request: LlmApprovalRequestPayload;
}): boolean {
  const rule = params.rule;
  if (rule.enabled === false) return false;

  const host = safeUrlHost(params.request.url);
  const pathName = safeUrlPath(params.request.url);

  const matches = (want: string | undefined, got: string | null | undefined) => {
    if (!want) return true;
    const g = (got ?? "").trim();
    if (!g) return false;
    if (g === want) return true;
    return false;
  };

  if (rule.urlHost && rule.urlHost !== host) return false;
  if (rule.urlPathPrefix && !pathName.startsWith(rule.urlPathPrefix)) return false;
  if (!matches(rule.provider, params.request.provider)) return false;
  if (!matches(rule.modelId, params.request.modelId)) return false;
  if (!matches(rule.source, params.request.source)) return false;
  if (!matches(rule.sessionKey, params.request.sessionKey)) return false;

  return true;
}

export function shouldAskLlmApproval(params: {
  approvals: LlmApprovalsFile;
  request: LlmApprovalRequestPayload;
}): { ask: boolean; matchedRuleId?: string } {
  const approvals = normalizeLlmApprovals(params.approvals);
  if (approvals.enabled === false) return { ask: false };
  if (approvals.ask === "off") return { ask: false };
  
  // 🆕 检查请求是否包含 tool result
  // 只有包含 tool result 的请求才需要审批（tool call 执行完要发回 LLM 的请求）
  // 不包含 tool result 的请求（初始请求、LLM 返回 tool call）不需要审批
  const hasToolResult = checkHasToolResult(params.request);
  
  // 如果配置为 "always"，但请求不包含 tool result，则跳过审批
  if (approvals.ask === "always") {
    if (!hasToolResult) {
      console.log(`[llm-approval] ⏭️ 跳过审批：请求不包含 tool result（初始请求或 LLM 返回 tool call）`);
      return { ask: false };
    }
    return { ask: true };
  }
  
  const rules = approvals.rules ?? [];
  const hit = rules.find((rule) => matchLlmRule({ rule, request: params.request }));
  if (hit) return { ask: false, matchedRuleId: hit.id };
  
  // 如果没有匹配的规则，检查是否包含 tool result
  if (!hasToolResult) {
    console.log(`[llm-approval] ⏭️ 跳过审批：请求不包含 tool result（初始请求或 LLM 返回 tool call）`);
    return { ask: false };
  }
  
  return { ask: true };
}

// 🆕 检查请求体中是否包含 tool result
function checkHasToolResult(request: LlmApprovalRequestPayload): boolean {
  if (!request.bodyText) return false;
  
  try {
    const parsed = JSON.parse(request.bodyText);
    if (!parsed || typeof parsed !== "object") return false;
    
    // OpenAI format: messages[].role="tool"
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (typeof msg === "object" && msg !== null) {
          const role = (msg as Record<string, unknown>).role;
          if (role === "tool" || role === "toolResult") {
            return true;
          }
        }
      }
    }
    
    // Google Generative AI format: contents[].parts[].functionResponse
    if (Array.isArray(parsed.contents)) {
      for (const content of parsed.contents) {
        if (typeof content === "object" && content !== null) {
          const parts = (content as Record<string, unknown>).parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (typeof part === "object" && part !== null) {
                if ((part as Record<string, unknown>).functionResponse) {
                  return true;
                }
              }
            }
          }
        }
      }
    }
    
    return false;
  } catch {
    return false;
  }
}

export function addAllowAlwaysRule(params: {
  approvals: LlmApprovalsFile;
  request: LlmApprovalRequestPayload;
  summary?: string;
}): LlmApprovalsFile {
  const approvals = normalizeLlmApprovals(params.approvals);
  const urlHost = safeUrlHost(params.request.url);
  const urlPath = safeUrlPath(params.request.url);
  const urlPathPrefix = urlPath ? urlPath.split("?")[0] : "";

  const nextRule: LlmApprovalRule = normalizeRule({
    id: crypto.randomUUID(),
    enabled: true,
    provider: params.request.provider ?? undefined,
    modelId: params.request.modelId ?? undefined,
    source: params.request.source ?? undefined,
    sessionKey: params.request.sessionKey ?? undefined,
    urlHost: urlHost || undefined,
    urlPathPrefix: urlPathPrefix || undefined,
    lastUsedAt: Date.now(),
    lastUsedSummary: params.summary,
  });

  const rules = approvals.rules ?? [];
  const exists = rules.some((rule) => matchLlmRule({ rule, request: params.request }));
  if (!exists) {
    rules.push(nextRule);
  }
  return { ...approvals, rules };
}
