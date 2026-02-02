/**
 * 完整测试 Agent 运行流程
 */

import { spawn } from "child_process";
import fs from "fs";

console.log("🧪 Testing full agent flow with Pipeline...\n");

// 清理旧的 session 文件
const sessionFile = "C:\\Users\\zouta\\.clawdbot\\agents\\main\\sessions\\test-pipeline-lina.jsonl";
if (fs.existsSync(sessionFile)) {
  fs.unlinkSync(sessionFile);
  console.log("✅ Cleaned up old session file\n");
}

// 运行 agent 命令
const agent = spawn("node", [
  "--import", "tsx",
  "src/entry.ts",
  "agent",
  "--message", "栗娜，你好",
  "--thinking", "low",
  "--session-id", "test-pipeline-lina"
], {
  cwd: process.cwd(),
  env: { ...process.env, CLAWDBOT_LOG_LEVEL: "debug" },
});

let output = "";
agent.stdout.on("data", (data) => {
  const text = data.toString();
  output += text;
  // 只打印包含 Pipeline 或 hook 的行
  if (text.includes("Pipeline") || text.includes("hook") || text.includes("character")) {
    process.stdout.write(text);
  }
});

agent.stderr.on("data", (data) => {
  const text = data.toString();
  output += text;
  // 只打印包含 Pipeline 或 hook 的行
  if (text.includes("Pipeline") || text.includes("hook") || text.includes("character")) {
    process.stderr.write(text);
  }
});

agent.on("close", (code) => {
  console.log(`\n\n✅ Agent finished with code ${code}\n`);
  
  // 检查结果
  if (output.includes("🔵 [Pipeline]")) {
    console.log("✅ Pipeline hook was triggered");
  } else {
    console.log("❌ Pipeline hook was NOT triggered");
  }
  
  if (output.includes("Detected character: lina")) {
    console.log("✅ Character detected: lina");
  } else {
    console.log("❌ Character NOT detected");
  }
  
  if (output.includes("🔵 [Pipeline Active]")) {
    console.log("✅ Pipeline marker found");
  } else {
    console.log("❌ Pipeline marker NOT found");
  }
  
  // 检查是否加载了栗娜的人格
  if (output.includes("栗娜") || output.includes("lina") || output.includes("Lina")) {
    console.log("✅ Lina personality might be loaded");
  } else {
    console.log("❌ Lina personality NOT loaded");
  }
});
