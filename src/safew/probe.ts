import { makeProxyFetch } from "./proxy.js";

const SAFEW_API_BASE = "https://api.safew.org";

export type SafewProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  bot?: {
    id?: number | null;
    username?: string | null;
    canJoinGroups?: boolean | null;
    canReadAllGroupMessages?: boolean | null;
    supportsInlineQueries?: boolean | null;
  };
  webhook?: { url?: string | null; hasCustomCert?: boolean | null };
};

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
  retries = 2,
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetcher(url, { signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // 如果是网络错误且还有重试次数，等待后重试
      if (attempt < retries) {
        const isNetworkError = 
          lastError.message.includes("ECONNRESET") ||
          lastError.message.includes("ETIMEDOUT") ||
          lastError.message.includes("ENOTFOUND") ||
          lastError.message.includes("network socket disconnected");
        
        if (isNetworkError) {
          // 指数退避：第一次重试等待 1 秒，第二次等待 2 秒
          const backoffMs = 1000 * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
      }
      
      // 非网络错误或已用完重试次数，抛出错误
      throw lastError;
    }
  }
  
  throw lastError ?? new Error("Fetch failed after retries");
}

export async function probeSafew(
  token: string,
  timeoutMs: number,
  proxyUrl?: string,
): Promise<SafewProbe> {
  const started = Date.now();
  const fetcher = proxyUrl ? makeProxyFetch(proxyUrl) : fetch;
  const base = `${SAFEW_API_BASE}/bot${token}`;

  const result: SafewProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };

  try {
    // 增加超时时间到 15 秒，并启用重试机制
    const effectiveTimeout = Math.max(timeoutMs, 15000);
    const meRes = await fetchWithTimeout(`${base}/getMe`, effectiveTimeout, fetcher);
    const meJson = (await meRes.json()) as {
      ok?: boolean;
      description?: string;
      result?: {
        id?: number;
        username?: string;
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
        supports_inline_queries?: boolean;
      };
    };
    if (!meRes.ok || !meJson?.ok) {
      result.status = meRes.status;
      result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }

    result.bot = {
      id: meJson.result?.id ?? null,
      username: meJson.result?.username ?? null,
      canJoinGroups:
        typeof meJson.result?.can_join_groups === "boolean" ? meJson.result?.can_join_groups : null,
      canReadAllGroupMessages:
        typeof meJson.result?.can_read_all_group_messages === "boolean"
          ? meJson.result?.can_read_all_group_messages
          : null,
      supportsInlineQueries:
        typeof meJson.result?.supports_inline_queries === "boolean"
          ? meJson.result?.supports_inline_queries
          : null,
    };

    // Try to fetch webhook info, but don't fail health if it errors.
    try {
      const webhookRes = await fetchWithTimeout(`${base}/getWebhookInfo`, effectiveTimeout, fetcher);
      const webhookJson = (await webhookRes.json()) as {
        ok?: boolean;
        result?: { url?: string; has_custom_certificate?: boolean };
      };
      if (webhookRes.ok && webhookJson?.ok) {
        result.webhook = {
          url: webhookJson.result?.url ?? null,
          hasCustomCert: webhookJson.result?.has_custom_certificate ?? null,
        };
      }
    } catch {
      // ignore webhook errors for probe
    }

    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    // 友好的错误消息
    let errorMessage = err instanceof Error ? err.message : String(err);
    
    // 简化网络错误消息
    if (errorMessage.includes("ECONNRESET")) {
      errorMessage = "Network connection reset (网络连接被重置)";
    } else if (errorMessage.includes("ETIMEDOUT")) {
      errorMessage = "Network timeout (网络超时)";
    } else if (errorMessage.includes("ENOTFOUND")) {
      errorMessage = "DNS resolution failed (DNS 解析失败)";
    } else if (errorMessage.includes("network socket disconnected")) {
      errorMessage = "Network socket disconnected (网络套接字断开)";
    } else if (errorMessage.includes("aborted")) {
      errorMessage = "Request timeout (请求超时)";
    }
    
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: errorMessage,
      elapsedMs: Date.now() - started,
    };
  }
}
