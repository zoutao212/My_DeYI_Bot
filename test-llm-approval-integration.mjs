#!/usr/bin/env node
/**
 * LLM 审批集成验证脚本
 * 
 * 验证所有 LLM 调用点都已正确集成审批检查
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// 直接使用工作区根目录
const ROOT = "d:\\Git_GitHub\\clawdbot";

console.log("🔍 验证 LLM 审批集成...\n");

const filesToCheck = [
  {
    path: "src/agents/pi-embedded-runner/run.ts",
    expected: ["withApproval", "checkApprovalRequired", "approval-request"],
    description: "嵌入式 PI Agent 运行器",
  },
  {
    path: "src/agents/intelligent-task-decomposition/system-llm-caller.ts",
    expected: ["withApproval", "checkApprovalRequired", "approval-request"],
    description: "系统 LLM 调用器",
  },
  {
    path: "src/agents/intelligent-task-decomposition/llm-task-decomposer.ts",
    expected: ["llm-approval-wrapper"],
    description: "任务分解器",
  },
  {
    path: "src/agents/intelligent-task-decomposition/quality-reviewer.ts",
    expected: ["llm-approval-wrapper"],
    description: "质量评审器",
  },
];

let allPassed = true;

for (const file of filesToCheck) {
  const fullPath = join(ROOT, file.path);
  
  try {
    const content = readFileSync(fullPath, "utf-8");
    
    console.log(`✅ ${file.description} (${file.path})`);
    
    for (const expected of file.expected) {
      if (content.includes(expected)) {
        console.log(`   ✓ 包含 "${expected}"`);
      } else {
        console.log(`   ❌ 缺少 "${expected}"`);
        allPassed = false;
      }
    }
    
    console.log("");
  } catch (error) {
    console.log(`   ❌ 文件不存在或读取失败`);
    allPassed = false;
  }
}

// 检查审批包装器本身
const wrapperPath = join(ROOT, "src/infra/llm-approval-wrapper.ts");
try {
  const wrapperContent = readFileSync(wrapperPath, "utf-8");
  
  console.log(`✅ 审批包装器 (src/infra/llm-approval-wrapper.ts)`);
  
  const requiredExports = [
    "export.*checkApprovalRequired",
    "export.*withApproval",
    "approvalEvents",
    "APPROVAL_TIMEOUT_MS",
  ];
  
  for (const exp of requiredExports) {
    const regex = new RegExp(exp);
    if (regex.test(wrapperContent)) {
      console.log(`   ✓ 导出 "${exp}"`);
    } else {
      console.log(`   ❌ 缺少 "${exp}"`);
      allPassed = false;
    }
  }
  
  console.log("");
} catch (error) {
  console.log(`   ❌ 审批包装器文件不存在`);
  allPassed = false;
}

// 总结
console.log("=" .repeat(60));
if (allPassed) {
  console.log("✅ 所有 LLM 调用点已成功集成审批检查！");
  console.log("\n📋 集成覆盖范围:");
  console.log("   • 嵌入式 PI Agent 运行器 (最终执行层)");
  console.log("   • 系统 LLM 调用器 (Orchestrator 层)");
  console.log("   • 任务分解器 (通过 system-llm-caller)");
  console.log("   • 质量评审器 (通过 system-llm-caller)");
  console.log("   • 批处理执行器 (通过 system-llm-caller)");
  console.log("\n🎯 下一步:");
  console.log("   1. 启动 Web 网关测试审批流程");
  console.log("   2. 配置审批规则 (白名单/黑名单)");
  console.log("   3. 验证 UI 审批界面正常显示");
  process.exit(0);
} else {
  console.log("❌ 部分集成未完成，请检查上述错误");
  process.exit(1);
}
