/**
 * 测试 Pipeline Plugin 是否正确识别栗娜人格
 */

import { spawn } from "child_process";

console.log("🧪 Testing Pipeline Plugin with Lina character...\n");

// 测试 1：提到栗娜
console.log("Test 1: 提到栗娜");
const test1 = spawn("node", [
  "--import", "tsx", 
  "src/entry.ts", 
  "agent", 
  "--message", "栗娜，你好", 
  "--thinking", "low",
  "--session-id", "test-pipeline-lina"
], {
  cwd: process.cwd(),
  env: { ...process.env, CLAWDBOT_LOG_LEVEL: "info" },
});

let output1 = "";
test1.stdout.on("data", (data) => {
  output1 += data.toString();
  process.stdout.write(data);
});

test1.stderr.on("data", (data) => {
  output1 += data.toString();
  process.stderr.write(data);
});

test1.on("close", (code) => {
  console.log(`\n\nTest 1 finished with code ${code}`);
  
  // 检查是否包含 Pipeline 标记
  if (output1.includes("🔵 [Pipeline]")) {
    console.log("✅ Pipeline hook was triggered");
  } else {
    console.log("❌ Pipeline hook was NOT triggered");
  }
  
  if (output1.includes("Detected character: lina")) {
    console.log("✅ Character detected: lina");
  } else {
    console.log("❌ Character NOT detected");
  }
  
  if (output1.includes("🔵 [Pipeline Active]")) {
    console.log("✅ Pipeline marker found in system prompt");
  } else {
    console.log("❌ Pipeline marker NOT found");
  }
});
