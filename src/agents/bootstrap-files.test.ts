import path from "node:path";
import fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = context.bootstrapFiles.map((file) =>
        file.name === "AGENTS.md" ? { ...file, content: "hooked" } : file,
      );
    });

    const workspaceDir = await makeTempWorkspace("clawdbot-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    const agents = files.find((file) => file.name === "AGENTS.md");
    expect(agents?.content).toBe("hooked");
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = context.bootstrapFiles.map((file) =>
        file.name === "AGENTS.md" ? { ...file, content: "hooked" } : file,
      );
    });

    const workspaceDir = await makeTempWorkspace("clawdbot-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const agents = result.contextFiles.find((file) => file.path === "AGENTS.md");
    expect(agents?.content).toBe("hooked");
  });

  it("prefers language-specific bootstrap files when available", async () => {
    const workspaceDir = await makeTempWorkspace("clawdbot-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "base agents", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.zh.md"), "zh agents", "utf-8");

    const zh = await resolveBootstrapContextForRun({ workspaceDir, promptLanguage: "zh" });
    const agentsZh = zh.contextFiles.find((file) => file.path === "AGENTS.md");
    expect(agentsZh?.content).toBe("zh agents");

    const en = await resolveBootstrapContextForRun({ workspaceDir, promptLanguage: "en" });
    const agentsEn = en.contextFiles.find((file) => file.path === "AGENTS.md");
    expect(agentsEn?.content).toBe("base agents");
  });
});
