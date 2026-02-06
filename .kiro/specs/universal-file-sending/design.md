# 通用文件发送系统 - 设计文档

**功能名称**：universal-file-sending  
**创建日期**：2026-02-06  
**状态**：待实施

---

## 1. 架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                         LLM Agent                           │
│  (根据用户需求或任务完成情况决定是否发送文件)                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ 调用 send_file 工具
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    send_file 工具                           │
│  - 解析文件路径                                              │
│  - 验证文件存在性                                            │
│  - 获取会话信息                                              │
│  - 路由到对应频道                                            │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┐
        │             │             │             │
        ▼             ▼             ▼             ▼
┌──────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  Telegram    │ │ Discord  │ │  Slack   │ │   Web    │
│   发送器     │ │  发送器  │ │  发送器  │ │  网关    │
└──────────────┘ └──────────┘ └──────────┘ └──────────┘
```

### 1.2 核心组件

#### 1.2.1 send_file 工具

**位置**：`src/agents/tools/send-file-tool.ts`

**职责**：
- 接收 LLM 的文件发送请求
- 验证文件路径和安全性
- 获取当前会话信息
- 路由到对应的频道发送器

**接口**：
```typescript
interface SendFileParams {
  filePath: string;      // 文件路径
  caption?: string;      // 文件说明
}

interface SendFileResult {
  success: boolean;
  message?: string;
  error?: string;
  fileName?: string;
  fileSize?: number;
  channel?: string;
}
```

#### 1.2.2 频道发送器

**Telegram 发送器**：
- 使用 grammy 库
- 支持线程回复
- 文件大小限制：50MB

**Discord 发送器**：
- 使用 Discord API
- 文件大小限制：8MB

**Slack 发送器**：
- 使用 Slack API
- 文件大小限制：1GB

**Web 网关**：
- 在聊天界面显示文件卡片
- 提供下载链接

---

## 2. 数据流设计

### 2.1 用户主动请求流程

```
用户："把这个文件发给我"
  │
  ▼
LLM 理解请求
  │
  ▼
调用 send_file({ filePath: "./file.txt", caption: "这是您要的文件" })
  │
  ▼
send_file 工具：
  1. 解析路径 → ./file.txt
  2. 检查文件存在 → ✓
  3. 获取会话信息 → { channel: "telegram", chatId: "123" }
  4. 调用 Telegram 发送器
  │
  ▼
Telegram 发送器：
  1. 读取文件内容
  2. 调用 bot.api.sendDocument()
  3. 返回发送结果
  │
  ▼
返回给 LLM：{ success: true, fileName: "file.txt", fileSize: 1024 }
  │
  ▼
LLM 回复用户："✅ 已发送文件 file.txt（1 KB）"
```

### 2.2 LLM 主动发送流程

```
用户："帮我生成一份报告"
  │
  ▼
LLM 生成报告 → ./report.txt
  │
  ▼
LLM 主动调用 send_file({ filePath: "./report.txt", caption: "报告已完成" })
  │
  ▼
（后续流程同上）
```

### 2.3 写作任务集成流程

```
用户："写一篇 10000 字的小说"
  │
  ▼
任务分解器：分解为 5 个章节
  │
  ▼
执行子任务 1：写第一章
  │
  ▼
子任务完成 → 生成文件：./chapter1.txt
  │
  ▼
Orchestrator 检测到 requiresFileOutput = true
  │
  ▼
调用 send_file({ filePath: "./chapter1.txt", caption: "第一章已完成" })
  │
  ▼
（重复执行其他章节）
  │
  ▼
所有子任务完成 → FileManager 合并文件 → ./novel_complete.txt
  │
  ▼
调用 send_file({ filePath: "./novel_complete.txt", caption: "完整小说" })
```

---

## 3. 安全设计

### 3.1 路径验证

**允许的目录**：
- 工作目录：`workspaceDir`
- 任务目录：`~/.clawdbot/tasks/{sessionId}/`

**验证逻辑**：
```typescript
const allowedDirs = [
  workspaceDir,
  path.join(os.homedir(), ".clawdbot", "tasks"),
];

const resolvedPath = path.resolve(filePath);
const isAllowed = allowedDirs.some(dir => resolvedPath.startsWith(dir));

if (!isAllowed) {
  throw new Error("文件路径不在允许的目录内");
}
```

### 3.2 文件大小限制

**限制表**：
```typescript
const MAX_FILE_SIZE = {
  telegram: 50 * 1024 * 1024,  // 50 MB
  discord: 8 * 1024 * 1024,    // 8 MB
  slack: 1024 * 1024 * 1024,   // 1 GB
};
```

**验证逻辑**：
```typescript
if (fileSize > MAX_FILE_SIZE[channel]) {
  throw new Error(`文件太大（${formatFileSize(fileSize)}），超过 ${channel} 的限制`);
}
```

### 3.3 文件类型检查

**白名单**：
```typescript
const ALLOWED_EXTENSIONS = [
  ".txt", ".md", ".pdf", ".docx", ".xlsx",
  ".png", ".jpg", ".jpeg", ".gif",
  ".zip", ".tar", ".gz",
  ".json", ".csv", ".xml",
];
```

**验证逻辑**：
```typescript
const ext = path.extname(fileName).toLowerCase();
if (!ALLOWED_EXTENSIONS.includes(ext)) {
  throw new Error(`不支持的文件类型：${ext}`);
}
```

---

## 4. 集成设计

### 4.1 工具列表集成

**位置**：`src/agents/pi-tools.ts`

**修改**：
```typescript
export function createClawdbotCodingTools(params: {
  config: ClawdbotConfig;
  workspaceDir: string;
  // ... 其他参数
}): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [
    // ... 现有工具
    
    // 🆕 文件发送工具
    createSendFileTool({
      workspaceDir: params.workspaceDir,
    }),
  ];

  return tools;
}
```

### 4.2 系统提示词集成

**位置**：`src/agents/system-prompt.l10n.zh.ts`

**添加内容**：
```typescript
export const systemPromptZh = {
  // ... 现有内容
  
  tools: {
    // ... 现有工具说明
    
    sendFile: `
**文件发送**：

你可以使用 \`send_file\` 工具发送文件到用户的聊天频道。

**使用场景**：
- 用户明确要求发送文件："把这个文件发给我"
- 生成了文件后需要发送给用户
- 完成任务后发送结果文件

**示例**：
\`\`\`
用户：把刚才生成的报告发给我
→ 调用 send_file({ filePath: "./report.txt", caption: "这是您要的报告" })

用户：发送 /tmp/data.csv
→ 调用 send_file({ filePath: "/tmp/data.csv" })
\`\`\`

**注意事项**：
- 文件路径必须是绝对路径或相对于工作目录的路径
- 文件大小限制：Telegram 50MB，Discord 8MB
- 只发送用户明确要求的文件，不要随意发送
`,
  },
};
```

### 4.3 写作任务集成

**位置**：`src/agents/intelligent-task-decomposition/orchestrator.ts`

**修改**：
```typescript
// 子任务完成后发送文件
if (subTask.metadata?.requiresFileOutput && subTask.metadata?.outputFilePath) {
  await this.sendFileViaTool(
    subTask.metadata.outputFilePath,
    `子任务完成：${subTask.summary}`
  );
}

// 根任务完成后发送完整文件
if (taskTree.rootTask.metadata?.requiresFileOutput && this.fileManager) {
  const mergedFilePath = await this.fileManager.mergeTaskOutputs(taskTree);
  await this.sendFileViaTool(
    mergedFilePath,
    `完整输出：${taskTree.rootTask.summary}`
  );
}
```

**新增方法**：
```typescript
private async sendFileViaTool(filePath: string, caption: string): Promise<void> {
  // 通过工具调用发送文件
  // 实现细节见任务列表
}
```

---

## 5. 错误处理

### 5.1 错误类型

**文件不存在**：
```typescript
{
  success: false,
  error: "文件不存在：./file.txt"
}
```

**路径不允许**：
```typescript
{
  success: false,
  error: "文件路径不在允许的目录内"
}
```

**文件太大**：
```typescript
{
  success: false,
  error: "文件太大（100 MB），超过 Telegram 的限制（50 MB）"
}
```

**文件类型不支持**：
```typescript
{
  success: false,
  error: "不支持的文件类型：.exe"
}
```

**频道不支持**：
```typescript
{
  success: false,
  error: "不支持的频道类型：unknown"
}
```

**发送失败**：
```typescript
{
  success: false,
  error: "发送失败：网络错误"
}
```

### 5.2 错误日志

**格式**：
```typescript
console.error(`[send_file] ❌ Error:`, {
  filePath,
  channel,
  error: err.message,
  stack: err.stack,
});
```

---

## 6. 测试设计

### 6.1 单元测试

**测试文件**：`src/agents/tools/send-file-tool.test.ts`

**测试用例**：
1. 文件存在 → 发送成功
2. 文件不存在 → 返回错误
3. 路径不允许 → 返回错误
4. 文件太大 → 返回错误
5. 文件类型不支持 → 返回错误
6. 频道不支持 → 返回错误

### 6.2 集成测试

**测试场景**：
1. Telegram 频道发送文件
2. Discord 频道发送文件
3. Slack 频道发送文件
4. Web 网关展示文件
5. 写作任务完成后发送文件

---

## 7. 性能优化

### 7.1 文件读取优化

**策略**：
- 小文件（< 1MB）：一次性读取到内存
- 大文件（> 1MB）：使用流式读取

### 7.2 并发发送

**策略**：
- 支持同时发送多个文件
- 使用 Promise.all() 并发执行

### 7.3 缓存优化

**策略**：
- 缓存文件元信息（大小、类型）
- 避免重复读取文件

---

## 8. 扩展性设计

### 8.1 新增频道

**步骤**：
1. 在 `send-file-tool.ts` 中添加新的频道分支
2. 实现对应的发送方法
3. 添加频道特定的配置（文件大小限制等）
4. 添加单元测试

### 8.2 新增文件类型

**步骤**：
1. 在 `ALLOWED_EXTENSIONS` 中添加新的扩展名
2. 更新文档说明

### 8.3 新增功能

**可能的扩展**：
- 文件压缩（大文件自动压缩）
- 批量发送（一次发送多个文件）
- 文件预览（在聊天界面预览文件内容）
- 文件历史（记录发送过的文件）

---

**版本**：v1.0  
**最后更新**：2026-02-06  
**变更**：初始设计文档
