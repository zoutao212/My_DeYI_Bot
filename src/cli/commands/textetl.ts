import path from "node:path";
import os from "node:os";

import { Command } from "commander";

import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { importNovelTxtPathToTextEtl } from "../../textetl/importer.js";

function resolveAgentId(agent?: string): string {
  const cfg = loadConfig();
  const raw = agent?.trim();
  return raw || resolveDefaultAgentId(cfg);
}

export function registerTextEtlCommands(program: Command): void {
  const textetl = program.command("textetl").description("小说 TXT -> 可检索上下文（TextETL）");

  textetl
    .command("import")
    .description("导入小说 TXT（文件或目录）到切片资产目录")
    .requiredOption("--input <path>", "小说 TXT 文件路径")
    .option("--title <title>", "书名（默认从文件名推断）")
    .option("--output <dir>", "切片资产输出根目录（默认 clawd/NovelsChunkAssets）")
    .option("--storage <mode>", "切片存储模式：files/jsonl/both（默认 files）")
    .option("--agent <agentId>", "目标 agent（默认系统 workspace 的默认 agent）")
    .action(async (options: { input: string; title?: string; output?: string; storage?: string; agent?: string }) => {
      const cfg = loadConfig();
      const agentId = resolveAgentId(options.agent);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

      const outputRootDir = options.output?.trim() || path.resolve(os.homedir(), "clawd", "NovelsChunkAssets");
      const storageModeRaw = options.storage?.trim();
      const storageMode = storageModeRaw === "jsonl" || storageModeRaw === "both" || storageModeRaw === "files"
        ? storageModeRaw
        : undefined;

      const inputAbsPath = path.resolve(options.input);
      const result = await importNovelTxtPathToTextEtl({ workspaceDir, inputAbsPath, outputRootDir, storageMode });

      console.log("\n✅ TextETL 导入完成\n");
      console.log(`- input: ${inputAbsPath}`);
      console.log(`- output: ${outputRootDir}`);
      console.log(`- storage: ${storageMode ?? "files"}`);
      console.log(`- imported: ${result.imported.length}`);
      console.log(`- skipped: ${result.skipped}`);
      if (result.imported.length === 1) {
        const one = result.imported[0];
        console.log(`- bookId: ${one.bookId}`);
        console.log(`- title: ${one.bookTitle}`);
        console.log(`- chapters: ${one.chaptersWritten}`);
        console.log(`- totalChars: ${one.totalChars}`);
      }
      console.log("\n提示：后续写作/设计任务会优先从 NovelsChunkAssets 关键词检索注入；也可以运行 \"clawdbot memory status --deep\" 查看记忆索引状态（若你选择把切片也纳入 memory）。\n");
    });
}
