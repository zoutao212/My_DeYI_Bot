import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readSafewUpdateOffset, writeSafewUpdateOffset } from "./update-offset-store.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.CLAWDBOT_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-safew-"));
  process.env.CLAWDBOT_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("safew update offset store", () => {
  it("persists and reloads the last update id", async () => {
    await withTempStateDir(async () => {
      expect(await readSafewUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeSafewUpdateOffset({
        accountId: "primary",
        updateId: 421,
      });

      expect(await readSafewUpdateOffset({ accountId: "primary" })).toBe(421);
    });
  });
});
