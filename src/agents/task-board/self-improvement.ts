/**
 * 自我改进机制
 * 
 * 负责从任务执行中识别可复用的模式，并建议将其固化为规则或技能。
 */

import type { TaskBoard, Checkpoint } from "./types.js";

/**
 * 可复用模式
 */
export interface ReusablePattern {
  /** 模式名称 */
  name: string;
  /** 模式描述 */
  description: string;
  /** 适用场景 */
  applicableScenarios: string[];
  /** 操作步骤 */
  steps: string[];
  /** 出现次数 */
  occurrences: number;
}

/**
 * 自我改进建议
 */
export interface ImprovementSuggestion {
  /** 建议类型（rule 或 skill） */
  type: "rule" | "skill";
  /** 建议标题 */
  title: string;
  /** 建议描述 */
  description: string;
  /** 相关模式 */
  pattern: ReusablePattern;
}

/**
 * 自我改进机制
 */
export class SelfImprovementEngine {
  /**
   * 识别可复用模式
   * @param taskBoard 任务看板
   * @returns 可复用模式列表
   */
  identifyReusablePatterns(taskBoard: TaskBoard): ReusablePattern[] {
    const patterns: ReusablePattern[] = [];

    // 1. 分析检查点中的操作序列
    const operationSequences = this.extractOperationSequences(taskBoard.checkpoints);
    
    // 2. 识别重复的操作序列（出现 3 次以上）
    const repeatedSequences = this.findRepeatedSequences(operationSequences, 3);
    
    // 3. 将重复的操作序列转换为可复用模式
    for (const [sequence, count] of repeatedSequences) {
      patterns.push({
        name: `重复操作模式 ${patterns.length + 1}`,
        description: `以下操作序列在任务执行中重复出现了 ${count} 次`,
        applicableScenarios: ["类似的任务场景"],
        steps: sequence,
        occurrences: count
      });
    }

    // 4. 分析子任务的依赖关系模式
    const dependencyPatterns = this.analyzeDependencyPatterns(taskBoard);
    patterns.push(...dependencyPatterns);

    return patterns;
  }

  /**
   * 从检查点中提取操作序列
   */
  private extractOperationSequences(checkpoints: Checkpoint[]): string[][] {
    const sequences: string[][] = [];

    for (const checkpoint of checkpoints) {
      if (checkpoint.decisions.length > 0) {
        sequences.push(checkpoint.decisions);
      }
    }

    return sequences;
  }

  /**
   * 查找重复的操作序列
   */
  private findRepeatedSequences(
    sequences: string[][],
    minOccurrences: number
  ): Map<string[], number> {
    const sequenceMap = new Map<string, { sequence: string[]; count: number }>();

    for (const sequence of sequences) {
      const key = JSON.stringify(sequence);
      const existing = sequenceMap.get(key);
      
      if (existing) {
        existing.count++;
      } else {
        sequenceMap.set(key, { sequence, count: 1 });
      }
    }

    // 过滤出出现次数 >= minOccurrences 的序列
    const repeated = new Map<string[], number>();
    for (const { sequence, count } of sequenceMap.values()) {
      if (count >= minOccurrences) {
        repeated.set(sequence, count);
      }
    }

    return repeated;
  }

  /**
   * 分析依赖关系模式
   */
  private analyzeDependencyPatterns(taskBoard: TaskBoard): ReusablePattern[] {
    const patterns: ReusablePattern[] = [];

    // 检查是否有常见的依赖模式（例如：分析 -> 设计 -> 实现 -> 测试）
    const commonPattern = ["分析", "设计", "实现", "测试"];
    const taskTitles = taskBoard.subTasks.map(t => t.title);
    
    let matchCount = 0;
    for (const keyword of commonPattern) {
      if (taskTitles.some(title => title.includes(keyword))) {
        matchCount++;
      }
    }

    if (matchCount >= 3) {
      patterns.push({
        name: "标准软件开发流程",
        description: "任务遵循了标准的软件开发流程：分析 -> 设计 -> 实现 -> 测试",
        applicableScenarios: ["软件开发任务", "功能实现任务"],
        steps: commonPattern,
        occurrences: 1
      });
    }

    return patterns;
  }

  /**
   * 生成改进建议
   * @param patterns 可复用模式列表
   * @returns 改进建议列表
   */
  generateImprovementSuggestions(patterns: ReusablePattern[]): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [];

    for (const pattern of patterns) {
      // 如果模式出现次数 >= 3，建议固化为规则
      if (pattern.occurrences >= 3) {
        suggestions.push({
          type: "rule",
          title: `固化规则: ${pattern.name}`,
          description: `将 "${pattern.name}" 固化为规则，以便在未来的任务中自动应用`,
          pattern
        });
      }

      // 如果模式包含多个步骤，建议固化为技能
      if (pattern.steps.length >= 3) {
        suggestions.push({
          type: "skill",
          title: `创建技能: ${pattern.name}`,
          description: `将 "${pattern.name}" 固化为技能，以便快速执行类似的操作序列`,
          pattern
        });
      }
    }

    return suggestions;
  }

  /**
   * 调用 maintain-rules Power 固化经验
   * @param suggestion 改进建议
   * @returns 是否成功
   */
  async solidifyExperience(suggestion: ImprovementSuggestion): Promise<boolean> {
    try {
      // 调用 Kiro Powers 的 maintain-rules
      // 注意：这需要在实际环境中有 Kiro Powers 支持
      
      console.log(`\n💡 自我改进建议:`);
      console.log(`   类型: ${suggestion.type}`);
      console.log(`   标题: ${suggestion.title}`);
      console.log(`   描述: ${suggestion.description}`);
      console.log(`   模式: ${suggestion.pattern.name}`);
      console.log(`   步骤: ${suggestion.pattern.steps.join(" -> ")}`);
      console.log(`\n是否固化这个经验？(y/n)`);
      
      // TODO: 实际实现时，应该：
      // 1. 调用 kiroPowers 工具
      // 2. 传递正确的参数
      // 3. 处理返回结果
      
      // 示例调用（需要在实际环境中实现）:
      // const result = await kiroPowers({
      //   action: "use",
      //   powerName: "maintain-rules",
      //   serverName: "maintain-rules-server",
      //   toolName: "create-rule",
      //   arguments: {
      //     type: suggestion.type,
      //     title: suggestion.title,
      //     description: suggestion.description,
      //     pattern: suggestion.pattern.name,
      //     steps: suggestion.pattern.steps
      //   }
      // });
      
      // return result.success;
      
      return true;
    } catch (error) {
      console.error("固化经验失败:", error);
      return false;
    }
  }
}

/**
 * 创建自我改进引擎实例
 * @returns 自我改进引擎实例
 */
export function createSelfImprovementEngine(): SelfImprovementEngine {
  return new SelfImprovementEngine();
}
