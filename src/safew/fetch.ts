import { resolveFetch } from "../infra/fetch.js";

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveSafewFetch(proxyFetch?: typeof fetch): typeof fetch | undefined {
  if (proxyFetch) return resolveFetch(proxyFetch);
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.safew.proxy in config");
  }
  return fetchImpl;
}
