/**
 * 智能关键词抽取器 (Intelligent Keyword Extractor)
 *
 * 超越简单的分词，实现：
 * 1. 意图识别（询问型、创作型、查询型、任务型）
 * 2. 实体识别（人名、地名、组织名、专有名词）
 * 3. 时间敏感度分析（"昨天"、"上次"、"最近"）
 * 4. 语义扩展（同义词、上位词、相关词）
 *
 * @module memory/intelligent-keyword-extractor
 */

/** 意图类型 */
export type IntentType = 
  | "inquiry"      // 询问型："什么是..."、"为什么..."
  | "creation"     // 创作型："写一个..."、"创作..."
  | "lookup"       // 查询型："找一下..."、"我记得..."
  | "task"         // 任务型："帮我做..."、"执行..."
  | "chat"         // 闲聊型："你好"、"今天天气不错"
  | "unknown";     // 未知类型

/** 时间敏感度 */
export interface TemporalHint {
  /** 是否包含时间指示词 */
  hasTemporal: boolean;
  /** 时间范围 */
  range?: "recent" | "past" | "future" | "unspecified";
  /** 原始时间表达 */
  expressions: string[];
}

/** 命名实体 */
export interface NamedEntity {
  /** 实体类型 */
  type: "person" | "location" | "organization" | "artifact" | "concept";
  /** 实体文本 */
  text: string;
  /** 置信度 (0-1) */
  confidence: number;
}

/** 智能抽取结果 */
export interface IntelligentExtractionResult {
  /** 基础关键词 */
  keywords: string[];
  /** 识别的意图 */
  intent: IntentType;
  /** 时间敏感度 */
  temporal: TemporalHint;
  /** 命名实体 */
  entities: NamedEntity[];
  /** 语义扩展词（同义词、上位词） */
  expandedTerms: string[];
  /** 推荐的检索策略 */
  suggestedStrategy: RetrievalStrategy;
}

/** 推荐的检索策略 */
export type RetrievalStrategy = 
  | "precision"    // 精确检索：高阈值、少片段
  | "recall"       // 召回检索：低阈值、多片段
  | "hybrid"       // 混合检索：分层检索
  | "temporal"     // 时间优先：按时间排序
  | "semantic";    // 语义优先：向量检索为主;

// 中文停用词表（精简版）
const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这", "那",
  "他", "她", "它", "们", "这个", "那个", "什么", "怎么", "为什么",
]);

// 意图识别模式
const INTENT_PATTERNS: Array<{ pattern: RegExp; intent: IntentType }> = [
  { pattern: /(什么|为何|为什么|如何|怎样|怎么|何时|哪里|哪儿|谁)/, intent: "inquiry" },
  { pattern: /(写 | 创作 | 生成 | 绘制 | 制作 | 设计 | 编 | 拟)/, intent: "creation" },
  { pattern: /(找 | 查 | 搜 | 检索 | 回忆 | 记得 | 查看 | 列出)/, intent: "lookup" },
  { pattern: /(帮 | 请 | 执行 | 完成 | 做 | 实现 | 运行 | 启动)/, intent: "task" },
  { pattern: /^(好 | 嗯 | 哦 | 哈哈 | 嘿 | 你好 | 谢谢 | 再见)/, intent: "chat" },
];

// 时间指示词
const TEMPORAL_EXPRESSIONS = {
  recent: ["最近", "近期", "这几天", "今天", "本周", "本月", "刚刚", "刚才"],
  past: ["昨天", "前天", "上周", "上个月", "去年", "以前", "曾经", "上次", "之前"],
  future: ["明天", "后天", "下周", "下个月", "明年", "以后", "将来", "接下来"],
};

// 命名实体识别模式（简化版，可扩展）
const ENTITY_PATTERNS: Array<{ pattern: RegExp; type: NamedEntity["type"] }> = [
  // 人名： capitalized Chinese names (简化)
  { pattern: /[张王李赵刘陈杨黄吴徐周郑孙马朱胡郭何高林罗宋谢唐冯韩曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾韦付邱秦侯邵孟毛万段漕薛阎雷方孔牛段洪白]/g, type: "person" as const },
  // 地名后缀
  { pattern: /\w+(市 | 省 | 县 | 镇 | 村 | 洲 | 洋 | 海 | 山 | 河 | 湖|港|站|机场)/g, type: "location" as const },
  // 组织后缀
  { pattern: /\w+(公司 | 集团 | 局 | 所 | 院 | 校 | 大学 | 协会 | 联盟 | 部门 | 团队)/g, type: "organization" as const },
  // 作品/物品
  { pattern: /《[^》]+》|"[^"]+"/g, type: "artifact" as const },
];

/**
 * 智能抽取关键词和元信息
 */
export function intelligentExtract(text: string): IntelligentExtractionResult {
  const normalizedText = text.toLowerCase();
  
  // 1. 意图识别
  const intent = recognizeIntent(normalizedText);
  
  // 2. 时间敏感度分析
  const temporal = analyzeTemporal(normalizedText);
  
  // 3. 基础关键词抽取（去除停用词）
  const keywords = extractBasicKeywords(text);
  
  // 4. 命名实体识别
  const entities = recognizeEntities(text);
  
  // 5. 语义扩展
  const expandedTerms = expandSemantically(keywords, entities);
  
  // 6. 推荐检索策略
  const strategy = suggestRetrievalStrategy(intent, temporal, entities.length);
  
  return {
    keywords,
    intent,
    temporal,
    entities,
    expandedTerms,
    suggestedStrategy: strategy,
  };
}

/**
 * 意图识别
 */
function recognizeIntent(text: string): IntentType {
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(text)) {
      return intent;
    }
  }
  return "unknown";
}

/**
 * 时间敏感度分析
 */
function analyzeTemporal(text: string): TemporalHint {
  const expressions: string[] = [];
  let range: TemporalHint["range"] = "unspecified";
  
  for (const [tempRange, words] of Object.entries(TEMPORAL_EXPRESSIONS)) {
    for (const word of words) {
      if (text.includes(word)) {
        expressions.push(word);
        range = tempRange as TemporalHint["range"];
      }
    }
  }
  
  return {
    hasTemporal: expressions.length > 0,
    range: expressions.length > 0 ? range : undefined,
    expressions,
  };
}

/**
 * 基础关键词抽取
 */
function extractBasicKeywords(text: string): string[] {
  // 简单的中文分词（按字符分割，实际项目中应使用专业分词库）
  const chars = text.split("").filter(char => {
    // 保留中文字符、字母、数字
    return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(char) && !STOP_WORDS.has(char);
  });
  
  // 组合成词（简单策略：连续的中文字符组合）
  const words: string[] = [];
  let currentWord = "";
  
  for (const char of chars) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      currentWord += char;
    } else {
      if (currentWord.length >= 2) {
        words.push(currentWord);
      }
      currentWord = "";
      words.push(char); // 单独保留字母/数字
    }
  }
  
  if (currentWord.length >= 2) {
    words.push(currentWord);
  }
  
  // 去重，保留高频词
  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  
  // 返回出现次数>=1 的词（去掉过于常见的）
  return Array.from(freq.entries())
    .filter(([_, count]) => count >= 1)
    .map(([word]) => word)
    .slice(0, 15); // 最多 15 个关键词
}

/**
 * 命名实体识别
 */
function recognizeEntities(text: string): NamedEntity[] {
  const entities: NamedEntity[] = [];
  
  for (const { pattern, type } of ENTITY_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        entities.push({
          type,
          text: match,
          confidence: 0.7, // 简化版，实际应根据上下文计算
        });
      }
    }
  }
  
  // 去重
  const seen = new Set<string>();
  return entities.filter(entity => {
    if (seen.has(entity.text)) return false;
    seen.add(entity.text);
    return true;
  });
}

/**
 * 语义扩展
 */
function expandSemantically(keywords: string[], entities: NamedEntity[]): string[] {
  const expanded: string[] = [];
  
  // 实体类型扩展
  for (const entity of entities) {
    switch (entity.type) {
      case "person":
        expanded.push("角色", "人物", "姓名");
        break;
      case "location":
        expanded.push("地点", "场所", "位置");
        break;
      case "organization":
        expanded.push("机构", "组织", "单位");
        break;
      case "artifact":
        expanded.push("作品", "物品", "名称");
        break;
    }
  }
  
  // 简单同义词扩展（可根据领域知识库扩展）
  const synonymMap: Record<string, string[]> = {
    "记忆": ["回忆", "历史记录", "过往"],
    "小说": ["故事", "剧情", "章节"],
    "任务": ["工作", "事项", "项目"],
    "进度": ["进展", "状态", "情况"],
  };
  
  for (const keyword of keywords) {
    if (synonymMap[keyword]) {
      expanded.push(...synonymMap[keyword]);
    }
  }
  
  // 去重
  return Array.from(new Set(expanded)).slice(0, 10);
}

/**
 * 推荐检索策略
 */
function suggestRetrievalStrategy(
  intent: IntentType,
  temporal: TemporalHint,
  entityCount: number,
): RetrievalStrategy {
  // 有时间指示词 → 时间优先
  if (temporal.hasTemporal) {
    return "temporal";
  }
  
  // 有大量实体 → 精确检索
  if (entityCount >= 3) {
    return "precision";
  }
  
  // 根据意图选择
  switch (intent) {
    case "inquiry":
      return "precision"; // 询问需要精确答案
    case "creation":
      return "recall"; // 创作需要大量素材
    case "lookup":
      return "hybrid"; // 查询需要平衡召回率和准确率
    case "task":
      return "semantic"; // 任务需要理解语义
    default:
      return "hybrid";
  }
}

/**
 * 根据检索策略调整检索参数
 */
export function adjustRetrievalParams(strategy: RetrievalStrategy): {
  maxSnippets: number;
  minScore: number;
  prioritizeRecent: boolean;
} {
  switch (strategy) {
    case "precision":
      return {
        maxSnippets: 4,
        minScore: 0.6,
        prioritizeRecent: false,
      };
    case "recall":
      return {
        maxSnippets: 12,
        minScore: 0.25,
        prioritizeRecent: false,
      };
    case "hybrid":
      return {
        maxSnippets: 8,
        minScore: 0.35,
        prioritizeRecent: true,
      };
    case "temporal":
      return {
        maxSnippets: 6,
        minScore: 0.3,
        prioritizeRecent: true,
      };
    case "semantic":
      return {
        maxSnippets: 10,
        minScore: 0.3,
        prioritizeRecent: false,
      };
  }
}
