# 阶段 3：管家层实现（详细任务）

## 目标

实现管家层（栗娜），理解用户意图，委托任务给任务调度层，反馈结果给用户。

## 时间估算

第 5-6 周（约 10 个工作日）

## 任务列表

### 1. TaskDelegator 实现

- [ ] 1.1 创建 TaskDelegator 类
  - **文件**：`src/agents/butler/task-delegator.ts`
  - **实现**：
    ```typescript
    import type { TaskDelegationRequest, TaskDelegationResponse } from "../multi-layer/types.js";
    
    /**
     * 任务委托器
     * 
     * 职责：
     * - 接收管家层的任务委托
     * - 将任务传递给任务调度层
     * - 返回执行结果
     */
    export class TaskDelegator {
      constructor(
        private taskBoard: TaskBoard,
        private orchestrator: Orchestrator,
        private executor: Executor
      ) {}
      
      /**
       * 委托任务
       */
      async delegate(
        request: TaskDelegationRequest
      ): Promise<TaskDelegationResponse> {
        // TODO: 实现
        throw new Error("Not implemented");
      }
    }
    ```
  - **实现步骤**：
    1. 创建 `TaskDelegator` 类
    2. 添加构造函数，注入依赖
    3. 添加 `delegate` 方法签名
    4. 添加详细的 JSDoc 注释
  - **验收标准**：
    - 类定义完整
    - 构造函数参数正确
    - 方法签名正确
    - JSDoc 注释完整
    - 通过 `pnpm build` 编译检查
  - **依赖**：阶段 1 任务 2.1, 2.2
  - **预计时间**：30 分钟
  - _需求：2.2, 5.1, 5.2_

---

- [ ] 1.2 实现 delegate 方法 - 简单任务
  - **文件**：`src/agents/butler/task-delegator.ts`
  - **实现**：
    ```typescript
    /**
     * 委托任务
     */
    async delegate(
      request: TaskDelegationRequest
    ): Promise<TaskDelegationResponse> {
      // 1. 创建任务
      const task = await this.taskBoard.createTask({
        id: request.taskId,
        type: request.taskType,
        description: request.description,
        parameters: request.parameters,
        priority: request.priority || 'normal',
        timeout: request.timeout
      });
      
      // 2. 判断任务类型
      if (request.taskType === 'simple') {
        return this.executeSimpleTask(task, request.onProgress);
      } else if (request.taskType === 'complex') {
        return this.executeComplexTask(task, request.onProgress);
      } else if (request.taskType === 'skill') {
        return this.executeSkillTask(task, request.onProgress);
      }
      
      throw new Error(`Unknown task type: ${request.taskType}`);
    }
    
    /**
     * 执行简单任务
     */
    private async executeSimpleTask(
      task: Task,
      onProgress?: (progress: TaskProgress) => void
    ): Promise<TaskDelegationResponse> {
      try {
        // 直接调用执行层
        const result = await this.executor.execute(task);
        
        return {
          taskId: task.id,
          status: 'success',
          result
        };
      } catch (error) {
        return {
          taskId: task.id,
          status: 'failure',
          error: error.message
        };
      }
    }
    ```
  - **实现步骤**：
    1. 实现 `delegate` 方法主逻辑
    2. 创建任务并添加到 TaskBoard
    3. 根据任务类型分发到不同的执行方法
    4. 实现 `executeSimpleTask` 方法
    5. 添加错误处理
  - **验收标准**：
    - 方法逻辑正确
    - 正确创建任务
    - 正确分发任务
    - 错误处理完善
  - **依赖**：任务 1.1
  - **预计时间**：1 小时
  - _需求：2.2, 3.1, 8.1_

---

- [ ] 1.3 实现 delegate 方法 - 复杂任务
  - **文件**：`src/agents/butler/task-delegator.ts`
  - **实现**：
    ```typescript
    /**
     * 执行复杂任务
     */
    private async executeComplexTask(
      task: Task,
      onProgress?: (progress: TaskProgress) => void
    ): Promise<TaskDelegationResponse> {
      try {
        // 1. 分解任务
        const subtasks = await this.orchestrator.decompose(task);
        
        // 2. 执行子任务
        const results: TaskResult[] = [];
        for (let i = 0; i < subtasks.length; i++) {
          const subtask = subtasks[i];
          
          // 通知进度
          if (onProgress) {
            onProgress({
              taskId: task.id,
              progress: (i / subtasks.length) * 100,
              message: `执行子任务 ${i + 1}/${subtasks.length}`,
              currentSubtask: subtask.description
            });
          }
          
          // 执行子任务
          const result = await this.executor.execute(subtask);
          results.push({
            subtaskId: subtask.id,
            status: 'success',
            result
          });
        }
        
        // 3. 汇总结果
        return {
          taskId: task.id,
          status: 'success',
          result: this.aggregateResults(results),
          subtasks: results
        };
      } catch (error) {
        return {
          taskId: task.id,
          status: 'failure',
          error: error.message
        };
      }
    }
    
    /**
     * 汇总结果
     */
    private aggregateResults(results: TaskResult[]): unknown {
      return results.map(r => r.result);
    }
    ```
  - **实现步骤**：
    1. 实现 `executeComplexTask` 方法
    2. 调用 Orchestrator 分解任务
    3. 循环执行子任务
    4. 通知进度（如果有回调）
    5. 汇总结果
    6. 添加错误处理
  - **验收标准**：
    - 方法逻辑正确
    - 正确分解任务
    - 正确执行子任务
    - 正确通知进度
    - 正确汇总结果
    - 错误处理完善
  - **依赖**：任务 1.2
  - **预计时间**：1.5 小时
  - _需求：2.2, 3.2, 3.3, 3.5, 8.2_

---

- [ ] 1.4 实现 delegate 方法 - 技能任务
  - **文件**：`src/agents/butler/task-delegator.ts`
  - **实现**：
    ```typescript
    /**
     * 执行技能任务
     */
    private async executeSkillTask(
      task: Task,
      onProgress?: (progress: TaskProgress) => void
    ): Promise<TaskDelegationResponse> {
      try {
        // 调用技能执行器
        const result = await this.executor.executeSkill(
          task.parameters.skillName,
          task.parameters
        );
        
        return {
          taskId: task.id,
          status: 'success',
          result
        };
      } catch (error) {
        return {
          taskId: task.id,
          status: 'failure',
          error: error.message
        };
      }
    }
    ```
  - **实现步骤**：
    1. 实现 `executeSkillTask` 方法
    2. 调用 Executor 的 executeSkill 方法
    3. 返回结果
    4. 添加错误处理
  - **验收标准**：
    - 方法逻辑正确
    - 正确调用技能执行器
    - 错误处理完善
  - **依赖**：任务 1.2
  - **预计时间**：30 分钟
  - _需求：2.5_

---

### 2. ButlerAgent 实现

- [ ] 2.1 创建 ButlerAgent 类
  - **文件**：`src/agents/butler/agent.ts`
  - **实现**：
    ```typescript
    import type { TaskDelegator } from "./task-delegator.js";
    import type { SkillCaller } from "./skill-caller.js";
    import type { ConversationContext } from "../multi-layer/types.js";
    
    /**
     * 管家层 Agent（栗娜）
     * 
     * 职责：
     * - 理解用户意图
     * - 分解任务为可执行的子任务
     * - 委托任务给任务调度层
     * - 将执行结果以友好的方式反馈给用户
     * 
     * 能力：
     * - 调用独立的系统技能（记忆检索、知识查询等）
     * - 调用任务委托接口
     * - 处理对话前后的任务调度（记忆填充、总结归档）
     */
    export class ButlerAgent {
      constructor(
        private taskDelegator: TaskDelegator,
        private skillCaller: SkillCaller,
        private llmProvider: LLMProvider
      ) {}
      
      /**
       * 处理用户消息
       */
      async handleMessage(
        message: string,
        context: ConversationContext
      ): Promise<string> {
        // TODO: 实现
        throw new Error("Not implemented");
      }
    }
    ```
  - **实现步骤**：
    1. 创建 `ButlerAgent` 类
    2. 添加构造函数，注入依赖
    3. 添加 `handleMessage` 方法签名
    4. 添加详细的 JSDoc 注释
  - **验收标准**：
    - 类定义完整
    - 构造函数参数正确
    - 方法签名正确
    - JSDoc 注释完整
    - 通过 `pnpm build` 编译检查
  - **依赖**：任务 1.1
  - **预计时间**：30 分钟
  - _需求：2.1, 2.2, 2.3, 2.4, 2.5_

---

- [ ] 2.2 实现 beforeConversation 方法（记忆填充）
  - **文件**：`src/agents/butler/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 对话前任务调度（记忆填充）
     */
    private async beforeConversation(
      context: ConversationContext
    ): Promise<void> {
      try {
        // 委托记忆填充任务
        const memoryTask: TaskDelegationRequest = {
          taskId: `memory-fill-${Date.now()}`,
          taskType: 'skill',
          description: '填充相关记忆到上下文',
          parameters: {
            userId: context.userId,
            conversationId: context.conversationId
          }
        };
        
        const response = await this.taskDelegator.delegate(memoryTask);
        
        if (response.status === 'success' && response.result) {
          // 将记忆注入到上下文
          context.memories = response.result as Memory[];
        }
      } catch (error) {
        // 记录错误但不影响对话流程
        console.error('Memory fill failed:', error);
      }
    }
    ```
  - **实现步骤**：
    1. 实现 `beforeConversation` 方法
    2. 创建记忆填充任务
    3. 委托给 TaskDelegator
    4. 将结果注入到上下文
    5. 添加错误处理（不影响对话流程）
  - **验收标准**：
    - 方法逻辑正确
    - 正确创建记忆填充任务
    - 正确注入记忆到上下文
    - 错误不影响对话流程
  - **依赖**：任务 2.1
  - **预计时间**：45 分钟
  - _需求：14.1, 14.2, 14.5, 14.7_

---

- [ ] 2.3 实现 afterConversation 方法（总结归档）
  - **文件**：`src/agents/butler/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 对话后任务调度（总结归档）
     */
    private async afterConversation(
      context: ConversationContext,
      result: string
    ): Promise<void> {
      try {
        // 委托总结归档任务
        const summaryTask: TaskDelegationRequest = {
          taskId: `summary-archive-${Date.now()}`,
          taskType: 'skill',
          description: '总结对话并归档到长期记忆',
          parameters: {
            userId: context.userId,
            conversationId: context.conversationId,
            messages: context.messages,
            result
          }
        };
        
        // 异步执行，不等待结果
        this.taskDelegator.delegate(summaryTask).catch(err => {
          console.error('Summary archive failed:', err);
        });
      } catch (error) {
        // 记录错误但不影响对话流程
        console.error('Summary archive failed:', error);
      }
    }
    ```
  - **实现步骤**：
    1. 实现 `afterConversation` 方法
    2. 创建总结归档任务
    3. 异步委托给 TaskDelegator（不等待结果）
    4. 添加错误处理（不影响对话流程）
  - **验收标准**：
    - 方法逻辑正确
    - 正确创建总结归档任务
    - 异步执行不阻塞对话
    - 错误不影响对话流程
  - **依赖**：任务 2.1
  - **预计时间**：45 分钟
  - _需求：14.3, 14.4, 14.5, 14.7_

---

- [ ] 2.4 实现 understandIntent 方法
  - **文件**：`src/agents/butler/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 理解用户意图
     */
    private async understandIntent(
      message: string,
      context: ConversationContext
    ): Promise<Intent> {
      // 使用 LLM 分析用户意图
      const systemPrompt = `你是栗娜，主人的管家。请分析用户的意图，判断是：
1. task（需要执行的任务）
2. skill（需要调用的技能）
3. conversation（普通对话）

如果是任务，判断复杂度（simple/complex）。
如果是技能，识别技能名称。

返回 JSON 格式：
{
  "type": "task" | "skill" | "conversation",
  "description": "任务描述",
  "complexity": "simple" | "complex",
  "skillName": "技能名称",
  "parameters": {}
}`;
      
      const response = await this.llmProvider.chat({
        systemPrompt,
        messages: context.messages,
        userMessage: message
      });
      
      return JSON.parse(response);
    }
    ```
  - **实现步骤**：
    1. 实现 `understandIntent` 方法
    2. 构建意图分析的 System Prompt
    3. 调用 LLM 分析意图
    4. 解析 JSON 响应
    5. 返回 Intent 对象
  - **验收标准**：
    - 方法逻辑正确
    - System Prompt 清晰明确
    - 正确解析 LLM 响应
    - 错误处理完善
  - **依赖**：任务 2.1
  - **预计时间**：1 小时
  - _需求：2.1_

---

- [ ] 2.5 实现 handleMessage 方法
  - **文件**：`src/agents/butler/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 处理用户消息
     */
    async handleMessage(
      message: string,
      context: ConversationContext
    ): Promise<string> {
      // 1. 对话前任务调度（记忆填充）
      await this.beforeConversation(context);
      
      // 2. 理解用户意图
      const intent = await this.understandIntent(message, context);
      
      // 3. 根据意图执行操作
      let result: string;
      if (intent.type === 'task') {
        result = await this.handleTask(intent);
      } else if (intent.type === 'skill') {
        result = await this.handleSkill(intent);
      } else {
        result = await this.handleConversation(message, context);
      }
      
      // 4. 对话后任务调度（总结归档）
      await this.afterConversation(context, result);
      
      return result;
    }
    ```
  - **实现步骤**：
    1. 实现 `handleMessage` 方法
    2. 调用 `beforeConversation` 填充记忆
    3. 调用 `understandIntent` 分析意图
    4. 根据意图类型分发到不同的处理方法
    5. 调用 `afterConversation` 归档总结
    6. 返回结果
  - **验收标准**：
    - 方法逻辑正确
    - 正确调用对话前后任务调度
    - 正确分析和处理意图
    - 错误处理完善
  - **依赖**：任务 2.2, 2.3, 2.4
  - **预计时间**：1 小时
  - _需求：2.1, 2.2, 2.3, 14.1, 14.3_

---

### 3. 单元测试

- [ ] 3.1 测试 TaskDelegator
  - **文件**：`src/agents/butler/task-delegator.test.ts`
  - **实现**：
    ```typescript
    describe('TaskDelegator', () => {
      describe('delegate - simple task', () => {
        it('should execute simple task directly', async () => {
          const delegator = new TaskDelegator(mockTaskBoard, mockOrchestrator, mockExecutor);
          
          const request: TaskDelegationRequest = {
            taskId: 'test-1',
            taskType: 'simple',
            description: '读取文件',
            parameters: { path: '/tmp/test.txt' }
          };
          
          const response = await delegator.delegate(request);
          
          expect(response.status).toBe('success');
          expect(mockExecutor.execute).toHaveBeenCalled();
          expect(mockOrchestrator.decompose).not.toHaveBeenCalled();
        });
      });
      
      describe('delegate - complex task', () => {
        it('should decompose and execute complex task', async () => {
          const delegator = new TaskDelegator(mockTaskBoard, mockOrchestrator, mockExecutor);
          
          const request: TaskDelegationRequest = {
            taskId: 'test-2',
            taskType: 'complex',
            description: '创建一个完整的 Web 应用',
            parameters: {}
          };
          
          const response = await delegator.delegate(request);
          
          expect(response.status).toBe('success');
          expect(mockOrchestrator.decompose).toHaveBeenCalled();
          expect(mockExecutor.execute).toHaveBeenCalledTimes(3); // 假设分解为 3 个子任务
        });
      });
    });
    ```
  - **验收标准**：
    - 所有测试通过
    - 测试覆盖简单任务、复杂任务、技能任务
    - 测试代码清晰易读
  - **依赖**：任务 1.2, 1.3, 1.4
  - **预计时间**：1 小时
  - _需求：2.2, 3.1, 3.2, 8.1, 8.2_

---

- [ ] 3.2 测试 ButlerAgent
  - **文件**：`src/agents/butler/agent.test.ts`
  - **实现**：
    ```typescript
    describe('ButlerAgent', () => {
      describe('handleMessage', () => {
        it('should delegate tasks instead of executing tools directly', async () => {
          const butler = new ButlerAgent(mockTaskDelegator, mockSkillCaller, mockLLMProvider);
          
          await butler.handleMessage('请写入文件到 /tmp/test.txt', mockContext);
          
          // 验证调用了 delegateTask()
          expect(mockTaskDelegator.delegate).toHaveBeenCalled();
          
          // 验证没有直接调用工具
          expect(mockToolExecutor.execute).not.toHaveBeenCalled();
        });
        
        it('should fill memory before conversation', async () => {
          const butler = new ButlerAgent(mockTaskDelegator, mockSkillCaller, mockLLMProvider);
          
          await butler.handleMessage('你好', mockContext);
          
          // 验证调用了记忆填充
          expect(mockTaskDelegator.delegate).toHaveBeenCalledWith(
            expect.objectContaining({
              taskType: 'skill',
              description: expect.stringContaining('记忆')
            })
          );
        });
        
        it('should archive summary after conversation', async () => {
          const butler = new ButlerAgent(mockTaskDelegator, mockSkillCaller, mockLLMProvider);
          
          await butler.handleMessage('你好', mockContext);
          
          // 等待异步任务
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // 验证调用了总结归档
          expect(mockTaskDelegator.delegate).toHaveBeenCalledWith(
            expect.objectContaining({
              taskType: 'skill',
              description: expect.stringContaining('总结')
            })
          );
        });
      });
    });
    ```
  - **验收标准**：
    - 所有测试通过
    - 测试覆盖任务委托、记忆填充、总结归档
    - 测试代码清晰易读
  - **依赖**：任务 2.5
  - **预计时间**：1 小时
  - _需求：2.2, 2.4, 14.1, 14.3_

---

### 4. Checkpoint

- [ ] 4.1 运行所有测试
  - **命令**：`pnpm test src/agents/butler/`
  - **验收标准**：所有测试通过
  - **预计时间**：10 分钟

- [ ] 4.2 编译检查
  - **命令**：`pnpm build`
  - **验收标准**：编译成功，无错误
  - **预计时间**：5 分钟

- [ ] 4.3 代码审查
  - **检查项**：
    - 代码符合 TypeScript 规范
    - JSDoc 注释完整
    - 错误处理完善
    - 测试覆盖充分
  - **预计时间**：30 分钟

---

## 总结

阶段 3 完成后，管家层将能够：
- ✅ 理解用户意图
- ✅ 委托任务给任务调度层
- ✅ 对话前自动填充记忆
- ✅ 对话后自动归档总结
- ✅ 不直接执行工具调用

**下一步**：阶段 4 - 任务调度层适配器实现
