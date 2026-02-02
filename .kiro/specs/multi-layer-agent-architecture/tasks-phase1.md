# 阶段 1：基础设施准备（详细任务）

## 目标

搭建多层架构的基础设施，不影响现有功能。

## 时间估算

第 1-2 周（约 10 个工作日）

## 任务列表

### 1. 创建目录结构

- [ ] 1.1 创建多层架构目录
  - **文件**：创建以下目录
    - `src/agents/virtual-world/`
    - `src/agents/butler/`
    - `src/agents/execution/`
    - `src/agents/multi-layer/`
  - **实现步骤**：
    1. 在 `src/agents/` 下创建 `virtual-world/` 目录
    2. 在 `src/agents/` 下创建 `butler/` 目录
    3. 在 `src/agents/` 下创建 `execution/` 目录
    4. 在 `src/agents/` 下创建 `multi-layer/` 目录
  - **验收标准**：
    - 所有目录创建成功
    - 目录结构符合设计文档
    - 可以在每个目录下创建文件
  - **依赖**：无
  - **预计时间**：10 分钟
  - _需求：9.1_

---

### 2. 定义核心类型和接口

- [ ] 2.1 创建 TaskDelegationRequest 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 任务委托请求
     */
    export interface TaskDelegationRequest {
      /** 任务 ID，用于跟踪任务 */
      taskId: string;
      
      /** 任务类型 */
      taskType: 'simple' | 'complex' | 'skill';
      
      /** 任务描述 */
      description: string;
      
      /** 任务参数 */
      parameters?: Record<string, unknown>;
      
      /** 优先级，默认为 normal */
      priority?: 'low' | 'normal' | 'high';
      
      /** 超时时间（毫秒） */
      timeout?: number;
      
      /** 进度回调函数 */
      onProgress?: (progress: TaskProgress) => void;
    }
    ```
  - **验收标准**：
    - 接口定义完整，包含所有必需字段
    - 类型定义准确，使用 TypeScript 严格模式
    - 添加 JSDoc 注释说明每个字段的含义
    - 通过 `pnpm build` 编译检查
  - **依赖**：任务 1.1
  - **预计时间**：30 分钟
  - _需求：5.1_

- [ ] 2.2 创建 TaskDelegationResponse 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 任务委托响应
     */
    export interface TaskDelegationResponse {
      /** 任务 ID */
      taskId: string;
      
      /** 执行状态 */
      status: 'success' | 'failure' | 'partial';
      
      /** 执行结果 */
      result?: unknown;
      
      /** 错误信息（如果失败） */
      error?: string;
      
      /** 子任务结果（如果是复杂任务） */
      subtasks?: TaskResult[];
    }
    ```
  - **验收标准**：
    - 接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：20 分钟
  - _需求：5.1_

- [ ] 2.3 创建 TaskProgress 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 任务进度信息
     */
    export interface TaskProgress {
      /** 任务 ID */
      taskId: string;
      
      /** 进度百分比（0-100） */
      progress: number;
      
      /** 进度消息 */
      message: string;
      
      /** 当前子任务描述 */
      currentSubtask?: string;
    }
    ```
  - **验收标准**：
    - 接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：15 分钟
  - _需求：5.5_

- [ ] 2.4 创建 TaskError 接口和枚举
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 任务错误类型
     */
    export enum TaskErrorType {
      TIMEOUT = 'timeout',
      TOOL_ERROR = 'tool_error',
      PARSE_ERROR = 'parse_error',
      PERMISSION_ERROR = 'permission_error',
      UNKNOWN_ERROR = 'unknown_error'
    }
    
    /**
     * 任务错误信息
     */
    export interface TaskError {
      /** 错误类型 */
      type: TaskErrorType;
      
      /** 错误消息 */
      message: string;
      
      /** 详细信息 */
      details?: unknown;
      
      /** 是否可重试 */
      retryable: boolean;
    }
    ```
  - **验收标准**：
    - 枚举和接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：20 分钟
  - _需求：6.2_

- [ ] 2.5 创建 Intent 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 用户意图
     */
    export interface Intent {
      /** 意图类型 */
      type: 'task' | 'skill' | 'conversation';
      
      /** 意图描述 */
      description: string;
      
      /** 任务复杂度（仅任务类型） */
      complexity?: 'simple' | 'complex';
      
      /** 技能名称（仅技能类型） */
      skillName?: string;
      
      /** 参数 */
      parameters?: Record<string, unknown>;
    }
    ```
  - **验收标准**：
    - 接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：20 分钟
  - _需求：2.1_

- [ ] 2.6 创建 ConversationContext 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 对话上下文
     */
    export interface ConversationContext {
      /** 用户 ID */
      userId: string;
      
      /** 对话 ID */
      conversationId: string;
      
      /** 消息历史 */
      messages: Message[];
      
      /** 相关记忆 */
      memories?: Memory[];
      
      /** 元数据 */
      metadata?: Record<string, unknown>;
    }
    
    /**
     * 消息
     */
    export interface Message {
      /** 角色 */
      role: 'user' | 'assistant' | 'system';
      
      /** 内容 */
      content: string;
      
      /** 时间戳 */
      timestamp: number;
    }
    
    /**
     * 记忆
     */
    export interface Memory {
      /** 记忆 ID */
      id: string;
      
      /** 记忆类型 */
      type: 'short_term' | 'long_term';
      
      /** 记忆内容 */
      content: string;
      
      /** 相关度（0-1） */
      relevance: number;
      
      /** 时间戳 */
      timestamp: number;
    }
    ```
  - **验收标准**：
    - 接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：30 分钟
  - _需求：6.1_

- [ ] 2.7 创建 CharacterProfile 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 角色配置
     */
    export interface CharacterProfile {
      /** 角色名称 */
      name: string;
      
      /** 角色描述 */
      description: string;
      
      /** 性格特点 */
      personality: string[];
      
      /** 背景故事 */
      background: string;
      
      /** 世界观 */
      worldView: string;
      
      /** 限制条件 */
      restrictions: string[];
    }
    ```
  - **验收标准**：
    - 接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：15 分钟
  - _需求：1.3_

- [ ] 2.8 创建 TaskResult 接口
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    /**
     * 任务结果
     */
    export interface TaskResult {
      /** 子任务 ID */
      subtaskId: string;
      
      /** 状态 */
      status: 'success' | 'failure';
      
      /** 结果 */
      result?: unknown;
      
      /** 错误信息 */
      error?: string;
    }
    ```
  - **验收标准**：
    - 接口定义完整
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.1
  - **预计时间**：15 分钟
  - _需求：3.5_

- [ ] 2.9 导出所有类型
  - **文件**：`src/agents/multi-layer/types.ts`
  - **实现**：
    ```typescript
    // 在文件末尾添加
    export type {
      TaskDelegationRequest,
      TaskDelegationResponse,
      TaskProgress,
      TaskError,
      Intent,
      ConversationContext,
      Message,
      Memory,
      CharacterProfile,
      TaskResult
    };
    
    export { TaskErrorType };
    ```
  - **验收标准**：
    - 所有类型正确导出
    - 可以在其他文件中导入使用
    - 通过编译检查
  - **依赖**：任务 2.1-2.8
  - **预计时间**：10 分钟
  - _需求：5.1, 6.1_

---

### 3. 实现层次判断逻辑

- [ ] 3.1 创建 AgentLayer 类型
  - **文件**：`src/agents/multi-layer/layer-resolver.ts`
  - **实现**：
    ```typescript
    /**
     * Agent 层次类型
     */
    export type AgentLayer = 'virtual-world' | 'butler' | 'execution';
    ```
  - **验收标准**：
    - 类型定义正确
    - 添加 JSDoc 注释
    - 通过编译检查
  - **依赖**：任务 2.9
  - **预计时间**：5 分钟
  - _需求：9.1_

- [ ] 3.2 实现 resolveAgentLayer 函数
  - **文件**：`src/agents/multi-layer/layer-resolver.ts`
  - **实现**：
    ```typescript
    import type { AgentLayer } from './layer-resolver.js';
    
    /**
     * 根据 sessionKey 和配置判断 Agent 层次
     * 
     * @param sessionKey - 会话标识
     * @param config - 配置对象
     * @returns Agent 层次
     */
    export function resolveAgentLayer(
      sessionKey: string,
      config?: Record<string, unknown>
    ): AgentLayer {
      // 1. 检查配置中的显式层次设置
      if (config?.agentLayer) {
        const layer = config.agentLayer as string;
        if (layer === 'virtual-world' || layer === 'butler' || layer === 'execution') {
          return layer;
        }
      }
      
      // 2. 根据 sessionKey 判断
      if (sessionKey.startsWith('virtual-world:')) {
        return 'virtual-world';
      }
      
      if (sessionKey.startsWith('butler:')) {
        return 'butler';
      }
      
      // 3. 默认使用执行层（向后兼容）
      return 'execution';
    }
    ```
  - **验收标准**：
    - 函数实现完整
    - 添加 JSDoc 注释
    - 支持配置优先
    - 支持 sessionKey 判断
    - 默认返回 execution（向后兼容）
    - 通过编译检查
  - **依赖**：任务 3.1
  - **预计时间**：30 分钟
  - _需求：9.1, 12.2_

- [ ] 3.3 编写 resolveAgentLayer 单元测试
  - **文件**：`src/agents/multi-layer/layer-resolver.test.ts`
  - **实现**：
    ```typescript
    import { describe, it, expect } from 'vitest';
    import { resolveAgentLayer } from './layer-resolver.js';
    
    describe('resolveAgentLayer', () => {
      it('should return layer from config when provided', () => {
        expect(resolveAgentLayer('any-key', { agentLayer: 'virtual-world' }))
          .toBe('virtual-world');
        expect(resolveAgentLayer('any-key', { agentLayer: 'butler' }))
          .toBe('butler');
        expect(resolveAgentLayer('any-key', { agentLayer: 'execution' }))
          .toBe('execution');
      });
      
      it('should return virtual-world for virtual-world: prefix', () => {
        expect(resolveAgentLayer('virtual-world:lisi', {}))
          .toBe('virtual-world');
      });
      
      it('should return butler for butler: prefix', () => {
        expect(resolveAgentLayer('butler:lina', {}))
          .toBe('butler');
      });
      
      it('should return execution by default', () => {
        expect(resolveAgentLayer('default-session', {}))
          .toBe('execution');
        expect(resolveAgentLayer('any-other-key'))
          .toBe('execution');
      });
      
      it('should prioritize config over sessionKey', () => {
        expect(resolveAgentLayer('virtual-world:lisi', { agentLayer: 'execution' }))
          .toBe('execution');
      });
    });
    ```
  - **验收标准**：
    - 测试覆盖所有分支
    - 测试配置优先级
    - 测试 sessionKey 判断
    - 测试默认行为
    - 所有测试通过
  - **依赖**：任务 3.2
  - **预计时间**：30 分钟
  - _需求：9.1_

---

### 4. 扩展 System Prompt 构建器

- [ ] 4.1 添加 agentLayer 参数到 buildEmbeddedSystemPrompt
  - **文件**：`src/agents/pi-embedded-runner/system-prompt.ts`
  - **实现**：
    1. 找到 `buildEmbeddedSystemPrompt` 函数
    2. 在参数接口中添加 `agentLayer?: AgentLayer`
    3. 导入 `AgentLayer` 类型：
       ```typescript
       import type { AgentLayer } from '../multi-layer/layer-resolver.js';
       ```
  - **验收标准**：
    - 参数添加成功
    - 类型导入正确
    - 保持向后兼容（参数可选）
    - 通过编译检查
  - **依赖**：任务 3.1
  - **预计时间**：15 分钟
  - _需求：13.1_

- [ ] 4.2 实现虚拟世界层 System Prompt 构建逻辑
  - **文件**：`src/agents/pi-embedded-runner/system-prompt.ts`
  - **实现**：
    ```typescript
    // 在 buildEmbeddedSystemPrompt 函数开头添加
    if (params.agentLayer === 'virtual-world') {
      // 虚拟世界层：只包含角色设定，不包含工具提示词
      return buildAgentSystemPrompt({
        ...params,
        toolNames: [], // 不包含工具
        toolSummaries: new Map(),
        // 移除所有工具相关的提示词
      });
    }
    ```
  - **验收标准**：
    - 虚拟世界层不包含工具提示词
    - 只包含角色设定
    - 保持向后兼容
    - 通过编译检查
  - **依赖**：任务 4.1
  - **预计时间**：30 分钟
  - _需求：13.1, 13.2_

- [ ] 4.3 实现管家层 System Prompt 构建逻辑
  - **文件**：`src/agents/pi-embedded-runner/system-prompt.ts`
  - **实现**：
    ```typescript
    // 在 buildEmbeddedSystemPrompt 函数中添加
    if (params.agentLayer === 'butler') {
      // 管家层：包含任务委托提示词，但不包含详细的工具说明
      const butlerPrompt = buildAgentSystemPrompt({
        ...params,
        // 简化工具说明
      });
      
      // 添加任务委托相关提示词
      return butlerPrompt + `\n\n你可以调用以下能力：
- delegateTask(): 委托任务给底层系统
- callSkill(): 调用独立技能（记忆检索、知识查询等）

注意：你不直接执行工具调用，而是委托给底层系统。`;
    }
    ```
  - **验收标准**：
    - 管家层包含任务委托提示词
    - 不包含详细的工具说明
    - 保持向后兼容
    - 通过编译检查
  - **依赖**：任务 4.2
  - **预计时间**：30 分钟
  - _需求：13.3_

- [ ] 4.4 实现执行层 System Prompt 构建逻辑
  - **文件**：`src/agents/pi-embedded-runner/system-prompt.ts`
  - **实现**：
    ```typescript
    // 在 buildEmbeddedSystemPrompt 函数中添加
    if (params.agentLayer === 'execution' || !params.agentLayer) {
      // 执行层：包含完整的工具使用提示词（默认行为）
      return buildAgentSystemPrompt(params);
    }
    ```
  - **验收标准**：
    - 执行层包含完整的工具提示词
    - 默认行为不变（向后兼容）
    - 通过编译检查
  - **依赖**：任务 4.3
  - **预计时间**：15 分钟
  - _需求：13.4_

- [ ] 4.5 编写 System Prompt 构建器单元测试
  - **文件**：`src/agents/pi-embedded-runner/system-prompt.test.ts`
  - **实现**：
    ```typescript
    import { describe, it, expect } from 'vitest';
    import { buildEmbeddedSystemPrompt } from './system-prompt.js';
    
    describe('buildEmbeddedSystemPrompt with agentLayer', () => {
      it('should not include tool prompts for virtual-world layer', () => {
        const prompt = buildEmbeddedSystemPrompt({
          agentLayer: 'virtual-world',
          // ... 其他参数
        });
        
        expect(prompt).not.toContain('tool');
        expect(prompt).not.toContain('function');
      });
      
      it('should include delegation prompts for butler layer', () => {
        const prompt = buildEmbeddedSystemPrompt({
          agentLayer: 'butler',
          // ... 其他参数
        });
        
        expect(prompt).toContain('delegateTask');
        expect(prompt).toContain('callSkill');
      });
      
      it('should include full tool prompts for execution layer', () => {
        const prompt = buildEmbeddedSystemPrompt({
          agentLayer: 'execution',
          // ... 其他参数
        });
        
        // 验证包含工具提示词
      });
      
      it('should default to execution layer when agentLayer is not provided', () => {
        const prompt = buildEmbeddedSystemPrompt({
          // agentLayer 未提供
          // ... 其他参数
        });
        
        // 验证默认行为
      });
    });
    ```
  - **验收标准**：
    - 测试覆盖所有层次
    - 测试默认行为
    - 所有测试通过
  - **依赖**：任务 4.4
  - **预计时间**：45 分钟
  - _需求：13.1, 13.2, 13.3, 13.4_

---

### 5. Checkpoint

- [ ] 5.1 运行所有测试
  - **命令**：`pnpm test`
  - **验收标准**：
    - 所有新增测试通过
    - 现有测试不受影响
    - 测试覆盖率 ≥ 80%
  - **依赖**：任务 3.3, 4.5
  - **预计时间**：15 分钟

- [ ] 5.2 运行编译检查
  - **命令**：`pnpm build`
  - **验收标准**：
    - 编译成功，无错误
    - 无类型错误
    - 无 lint 错误
  - **依赖**：任务 5.1
  - **预计时间**：10 分钟

- [ ] 5.3 代码审查
  - **检查项**：
    - 代码风格符合规范
    - JSDoc 注释完整
    - 类型定义准确
    - 向后兼容性
  - **验收标准**：
    - 所有检查项通过
    - 代码质量良好
  - **依赖**：任务 5.2
  - **预计时间**：30 分钟

- [ ] 5.4 询问用户是否有问题
  - **操作**：向用户确认阶段 1 是否完成，是否有问题需要解决
  - **依赖**：任务 5.3
  - **预计时间**：-

---

## 总结

**阶段 1 完成标志**：
- ✅ 目录结构创建完成
- ✅ 核心类型和接口定义完成
- ✅ 层次判断逻辑实现完成
- ✅ System Prompt 构建器扩展完成
- ✅ 所有测试通过
- ✅ 编译检查通过
- ✅ 代码审查通过

**下一步**：进入阶段 2（执行层封装）

---

**版本**：v1.0  
**最后更新**：2026-01-31  
**作者**：Kiro AI Assistant
