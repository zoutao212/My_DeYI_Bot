import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSafewFetch } from "./fetch.js";

describe("resolveSafewFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("returns wrapped global fetch when available", () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const resolved = resolveSafewFetch();
    expect(resolved).toBeTypeOf("function");
  });

  it("prefers proxy fetch when provided", () => {
    const fetchMock = vi.fn(async () => ({}));
    const resolved = resolveSafewFetch(fetchMock as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");
  });
});
