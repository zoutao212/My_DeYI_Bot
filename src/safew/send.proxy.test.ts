import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
    deleteMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

const { makeProxyFetch } = vi.hoisted(() => ({
  makeProxyFetch: vi.fn(),
}));

const { resolveSafewFetch } = vi.hoisted(() => ({
  resolveSafewFetch: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

vi.mock("./fetch.js", () => ({
  resolveSafewFetch,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch; timeoutSeconds?: number } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

import { deleteMessageSafew, reactMessageSafew, sendMessageSafew } from "./send.js";

describe("safew proxy client", () => {
  const proxyUrl = "http://proxy.test:8080";

  beforeEach(() => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.setMessageReaction.mockResolvedValue(undefined);
    botApi.deleteMessage.mockResolvedValue(true);
    botCtorSpy.mockReset();
    loadConfig.mockReturnValue({
      channels: { safew: { accounts: { foo: { proxy: proxyUrl } } } },
    });
    makeProxyFetch.mockReset();
    resolveSafewFetch.mockReset();
  });

  it("uses proxy fetch for sendMessage", async () => {
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn();
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveSafewFetch.mockReturnValue(fetchImpl as unknown as typeof fetch);

    await sendMessageSafew("123", "hi", { token: "tok", accountId: "foo" });

    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveSafewFetch).toHaveBeenCalledWith(proxyFetch);
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl }),
      }),
    );
  });

  it("uses proxy fetch for reactions", async () => {
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn();
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveSafewFetch.mockReturnValue(fetchImpl as unknown as typeof fetch);

    await reactMessageSafew("123", "456", "✅", { token: "tok", accountId: "foo" });

    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveSafewFetch).toHaveBeenCalledWith(proxyFetch);
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl }),
      }),
    );
  });

  it("uses proxy fetch for deleteMessage", async () => {
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn();
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveSafewFetch.mockReturnValue(fetchImpl as unknown as typeof fetch);

    await deleteMessageSafew("123", "456", { token: "tok", accountId: "foo" });

    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveSafewFetch).toHaveBeenCalledWith(proxyFetch);
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl }),
      }),
    );
  });
});
