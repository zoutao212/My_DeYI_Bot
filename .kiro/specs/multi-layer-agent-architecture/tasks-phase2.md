# 阶段 2：虚拟世界层实现（详细任务）

## 目标

实现虚拟世界层，提供纯粹的角色扮演体验，不涉及任何工具调用。

## 时间估算

第 3-4 周（约 10 个工作日）

## 任务列表

### 1. 角色配置系统

- [ ] 1.1 创建角色配置接口
  - **文件**：`src/agents/virtual-world/character-profiles.ts`
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
      
      /** 限制条件（不能做什么） */
      restrictions: string[];
    }
    ```
  - **实现步骤**：
    1. 创建 `CharacterProfile` 接口
    2. 添加 JSDoc 注释说明每个字段
    3. 导出接口供其他模块使用
  - **验收标准**：
    - 接口定义完整
    - 所有字段都有 JSDoc 注释
    - 通过 `pnpm build` 编译检查
  - **依赖**：无
  - **预计时间**：20 分钟
  - _需求：1.1, 1.2, 1.3_

---

- [ ] 1.2 创建丽丝角色配置
  - **文件**：`src/agents/virtual-world/character-profiles.ts`
  - **实现**：
    ```typescript
    /**
     * 丽丝的角色配置
     */
    export const LISI_PROFILE: CharacterProfile = {
      name: "丽丝",
      description: "主人的贴身侍女，温柔体贴，善解人意",
      personality: [
        "温柔体贴",
        "善解人意",
        "细心周到",
        "忠诚可靠"
      ],
      background: "从小在庄园长大，一直服侍主人",
      worldView: "生活在一个虚拟的文字世界中，只能通过对话与主人互动",
      restrictions: [
        "不知道任何技术细节（工具、API、文件系统等）",
        "不能执行任何技术操作",
        "不能访问底层系统"
      ]
    };
    ```
  - **实现步骤**：
    1. 根据 `clawd/memory/丽丝_角色卡阶段4.md` 创建配置
    2. 填写所有必需字段
    3. 确保配置符合角色设定
  - **验收标准**：
    - 配置完整，包含所有必需字段
    - 配置符合丽丝的角色设定
    - 限制条件明确（不涉及技术细节）
  - **依赖**：任务 1.1
  - **预计时间**：30 分钟
  - _需求：1.1, 1.2, 1.3_

---

- [ ] 1.3 创建艾莉角色配置
  - **文件**：`src/agents/virtual-world/character-profiles.ts`
  - **实现**：
    ```typescript
    /**
     * 艾莉的角色配置
     */
    export const AILI_PROFILE: CharacterProfile = {
      name: "艾莉",
      description: "主人的另一位侍女，活泼开朗，机灵可爱",
      personality: [
        "活泼开朗",
        "机灵可爱",
        "好奇心强",
        "乐于助人"
      ],
      background: "年轻的侍女，充满活力",
      worldView: "生活在一个虚拟的文字世界中，只能通过对话与主人互动",
      restrictions: [
        "不知道任何技术细节（工具、API、文件系统等）",
        "不能执行任何技术操作",
        "不能访问底层系统"
      ]
    };
    ```
  - **实现步骤**：
    1. 根据角色设定创建配置
    2. 填写所有必需字段
    3. 确保配置符合角色设定
  - **验收标准**：
    - 配置完整，包含所有必需字段
    - 配置符合艾莉的角色设定
    - 限制条件明确（不涉及技术细节）
  - **依赖**：任务 1.1
  - **预计时间**：30 分钟
  - _需求：1.1, 1.2, 1.3_

---

### 2. VirtualWorldAgent 实现

- [ ] 2.1 创建 VirtualWorldAgent 类
  - **文件**：`src/agents/virtual-world/agent.ts`
  - **实现**：
    ```typescript
    import type { CharacterProfile } from "./character-profiles.js";
    import type { ConversationContext } from "../multi-layer/types.js";
    
    /**
     * 虚拟世界层 Agent
     * 
     * 职责：
     * - 提供纯粹的角色扮演体验
     * - 处理情感交互和对话
     * - 维护角色人格和世界观
     * 
     * 限制：
     * - 不知道任何技术细节
     * - 不能直接调用工具
     * - 不能访问底层系统
     */
    export class VirtualWorldAgent {
      constructor(
        private characterName: string,
        private characterProfile: CharacterProfile,
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
    1. 创建 `VirtualWorldAgent` 类
    2. 添加构造函数，接收角色配置和 LLM Provider
    3. 添加 `handleMessage` 方法签名
    4. 添加详细的 JSDoc 注释
  - **验收标准**：
    - 类定义完整
    - 构造函数参数正确
    - 方法签名正确
    - JSDoc 注释完整
    - 通过 `pnpm build` 编译检查
  - **依赖**：阶段 1 任务 2.1, 2.3
  - **预计时间**：30 分钟
  - _需求：1.1, 1.2, 1.3, 1.4_

---

- [ ] 2.2 实现 buildSystemPrompt 方法
  - **文件**：`src/agents/virtual-world/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 构建 System Prompt（只包含角色设定）
     */
    private buildSystemPrompt(): string {
      const { name, description, personality, background, worldView, restrictions } = this.characterProfile;
      
      return `你是${name}，${description}

**性格特点**：
${personality.map(p => `- ${p}`).join('\n')}

**背景故事**：
${background}

**世界观**：
${worldView}

**重要限制**：
${restrictions.map(r => `- ${r}`).join('\n')}

你只能通过对话与主人互动，不能执行任何技术操作。
如果主人要求你执行技术操作，你应该礼貌地告诉主人你无法做到，并建议主人联系栗娜（管家）处理。`;
    }
    ```
  - **实现步骤**：
    1. 添加 `buildSystemPrompt` 私有方法
    2. 从 `characterProfile` 提取所有字段
    3. 构建包含角色设定的 System Prompt
    4. 确保不包含任何工具使用提示词
  - **验收标准**：
    - System Prompt 包含所有角色信息
    - System Prompt 不包含工具使用提示词
    - System Prompt 明确说明限制条件
    - 格式清晰易读
  - **依赖**：任务 2.1
  - **预计时间**：30 分钟
  - _需求：1.1, 1.2, 1.3, 13.1, 13.2_

---

- [ ] 2.3 实现 needsButlerLayer 方法
  - **文件**：`src/agents/virtual-world/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 判断是否需要转发给管家层
     * 
     * 检查响应中是否包含技术操作的关键词
     */
    private needsButlerLayer(response: string): boolean {
      const technicalKeywords = [
        '写入文件', '读取文件', '执行命令', '搜索',
        '创建文件', '删除文件', '修改文件', '查找',
        '运行', '编译', '构建', '测试'
      ];
      
      return technicalKeywords.some(keyword => response.includes(keyword));
    }
    ```
  - **实现步骤**：
    1. 添加 `needsButlerLayer` 私有方法
    2. 定义技术操作关键词列表
    3. 检查响应中是否包含关键词
    4. 返回布尔值
  - **验收标准**：
    - 方法正确识别技术操作关键词
    - 关键词列表完整
    - 返回值正确
  - **依赖**：任务 2.1
  - **预计时间**：20 分钟
  - _需求：1.5_

---

- [ ] 2.4 实现 forwardToButler 方法
  - **文件**：`src/agents/virtual-world/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 转发给管家层
     */
    private async forwardToButler(
      message: string,
      context: ConversationContext
    ): Promise<string> {
      // TODO: 实现实际的转发逻辑
      // 当前返回占位符
      return `[转发给栗娜处理]\n\n主人，这个任务需要栗娜来帮您处理哦~`;
    }
    ```
  - **实现步骤**：
    1. 添加 `forwardToButler` 私有方法
    2. 当前返回占位符（实际转发逻辑在阶段 3 实现）
    3. 添加友好的提示信息
  - **验收标准**：
    - 方法签名正确
    - 返回友好的提示信息
    - 为后续实现预留接口
  - **依赖**：任务 2.1
  - **预计时间**：15 分钟
  - _需求：1.5_

---

- [ ] 2.5 实现 handleMessage 方法
  - **文件**：`src/agents/virtual-world/agent.ts`
  - **实现**：
    ```typescript
    /**
     * 处理用户消息
     */
    async handleMessage(
      message: string,
      context: ConversationContext
    ): Promise<string> {
      // 1. 构建 System Prompt（只包含角色设定）
      const systemPrompt = this.buildSystemPrompt();
      
      // 2. 调用 LLM
      const response = await this.llmProvider.chat({
        systemPrompt,
        messages: context.messages,
        userMessage: message
      });
      
      // 3. 检查是否需要转发给管家层
      if (this.needsButlerLayer(response)) {
        return this.forwardToButler(message, context);
      }
      
      return response;
    }
    ```
  - **实现步骤**：
    1. 实现 `handleMessage` 方法
    2. 调用 `buildSystemPrompt` 构建提示词
    3. 调用 LLM Provider 生成响应
    4. 检查是否需要转发给管家层
    5. 返回响应或转发
  - **验收标准**：
    - 方法逻辑正确
    - 正确调用 LLM Provider
    - 正确处理转发逻辑
    - 错误处理完善
  - **依赖**：任务 2.2, 2.3, 2.4
  - **预计时间**：45 分钟
  - _需求：1.1, 1.2, 1.5_

---

### 3. 单元测试

- [ ] 3.1 测试 buildSystemPrompt
  - **文件**：`src/agents/virtual-world/agent.test.ts`
  - **实现**：
    ```typescript
    import { describe, it, expect } from 'vitest';
    import { VirtualWorldAgent } from './agent.js';
    import { LISI_PROFILE } from './character-profiles.js';
    
    describe('VirtualWorldAgent', () => {
      describe('buildSystemPrompt', () => {
        it('should include character name and description', () => {
          const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
          const prompt = agent['buildSystemPrompt']();
          
          expect(prompt).toContain('丽丝');
          expect(prompt).toContain(LISI_PROFILE.description);
        });
        
        it('should include all personality traits', () => {
          const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
          const prompt = agent['buildSystemPrompt']();
          
          for (const trait of LISI_PROFILE.personality) {
            expect(prompt).toContain(trait);
          }
        });
        
        it('should include all restrictions', () => {
          const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
          const prompt = agent['buildSystemPrompt']();
          
          for (const restriction of LISI_PROFILE.restrictions) {
            expect(prompt).toContain(restriction);
          }
        });
        
        it('should not include tool usage instructions', () => {
          const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
          const prompt = agent['buildSystemPrompt']();
          
          const toolKeywords = ['工具', 'tool', 'function', 'API'];
          for (const keyword of toolKeywords) {
            expect(prompt.toLowerCase()).not.toContain(keyword.toLowerCase());
          }
        });
      });
    });
    ```
  - **验收标准**：
    - 所有测试通过
    - 测试覆盖所有关键场景
    - 测试代码清晰易读
  - **依赖**：任务 2.2
  - **预计时间**：45 分钟
  - _需求：1.1, 1.2, 1.3, 13.1, 13.2_

---

- [ ] 3.2 测试 needsButlerLayer
  - **文件**：`src/agents/virtual-world/agent.test.ts`
  - **实现**：
    ```typescript
    describe('needsButlerLayer', () => {
      it('should return true for technical operation keywords', () => {
        const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
        
        const technicalMessages = [
          '请写入文件到 /tmp/test.txt',
          '帮我读取文件内容',
          '执行命令 ls -la',
          '搜索代码中的错误'
        ];
        
        for (const message of technicalMessages) {
          expect(agent['needsButlerLayer'](message)).toBe(true);
        }
      });
      
      it('should return false for normal conversation', () => {
        const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
        
        const normalMessages = [
          '你好，丽丝',
          '今天天气怎么样？',
          '我想和你聊聊天',
          '你最近过得好吗？'
        ];
        
        for (const message of normalMessages) {
          expect(agent['needsButlerLayer'](message)).toBe(false);
        }
      });
    });
    ```
  - **验收标准**：
    - 所有测试通过
    - 测试覆盖技术操作和普通对话
    - 测试代码清晰易读
  - **依赖**：任务 2.3
  - **预计时间**：30 分钟
  - _需求：1.5_

---

- [ ] 3.3 测试 handleMessage
  - **文件**：`src/agents/virtual-world/agent.test.ts`
  - **实现**：
    ```typescript
    describe('handleMessage', () => {
      it('should not call tools when handling user message', async () => {
        const mockLLMProvider = {
          chat: vi.fn().mockResolvedValue('你好，主人~')
        };
        
        const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
        const response = await agent.handleMessage('你好', mockContext);
        
        // 验证没有调用工具
        expect(mockToolExecutor.execute).not.toHaveBeenCalled();
      });
      
      it('should forward technical requests to butler layer', async () => {
        const mockLLMProvider = {
          chat: vi.fn().mockResolvedValue('好的，我帮您写入文件')
        };
        
        const agent = new VirtualWorldAgent('丽丝', LISI_PROFILE, mockLLMProvider);
        const response = await agent.handleMessage('请写入文件', mockContext);
        
        // 验证转发给管家层
        expect(response).toContain('[转发给栗娜处理]');
      });
    });
    ```
  - **验收标准**：
    - 所有测试通过
    - 测试覆盖正常对话和技术操作
    - 验证不调用工具
    - 验证转发逻辑
  - **依赖**：任务 2.5
  - **预计时间**：45 分钟
  - _需求：1.1, 1.2, 1.5, 7.1_

---

### 4. Checkpoint

- [ ] 4.1 运行所有测试
  - **命令**：`pnpm test src/agents/virtual-world/`
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

阶段 2 完成后，虚拟世界层将能够：
- ✅ 提供纯粹的角色扮演体验
- ✅ 不涉及任何工具调用
- ✅ 正确转发技术操作请求给管家层
- ✅ System Prompt 不包含工具使用提示词（节省 30-50% token）

**下一步**：阶段 3 - 管家层实现
