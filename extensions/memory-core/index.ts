import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) return null;
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // 记忆 CRUD 工具集（零外部依赖，不需要 embedding 配置）
    api.registerTool(
      (ctx) => {
        const crudTools = api.runtime.tools.createAllMemoryCrudTools({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        return crudTools.length > 0 ? crudTools : null;
      },
      { names: ["memory_write", "memory_update", "memory_delete", "memory_list", "memory_deep_search"] },
    );

    // 小说素材参考检索工具（零外部依赖，只需文件系统）
    api.registerTool(
      (ctx) => {
        const novelSearchTool = api.runtime.tools.createNovelReferenceSearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const novelListTool = api.runtime.tools.createNovelAssetsListTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const tools = [novelSearchTool, novelListTool].filter(Boolean);
        return tools.length > 0 ? tools : null;
      },
      { names: ["novel_reference_search", "novel_assets_list"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
