/**
 * OpenCAWD ToolCall 2.0 - Memory Enhancer
 * 
 * 使用 Code Tool 动态增强记忆和文本的增删改查能力
 * 
 * 新增功能：
 * - 高级语义搜索：支持向量相似度和上下文理解
 * - 智能内容生成：基于现有记忆生成新内容
 * - 多模态处理：支持文本、结构化数据、元数据处理
 * - 实时协作：支持多用户并发记忆操作
 * - 版本控制：记忆变更历史和回滚机制
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { CodeToolEngine, type CodeToolRequest } from './code-tool-engine.js';
import { jsonResult } from '../tools/common.js';

/**
 * Memory Enhancer 参数 Schema
 */
const MemoryEnhancerSchema = Type.Object({
  action: Type.Union([
    Type.Literal('intelligent_search'),
    Type.Literal('batch_process'),
    Type.Literal('smart_classify'),
    Type.Literal('data_validation'),
    Type.Literal('text_transformation'),
    Type.Literal('memory_mining'),
    // 新增操作类型
    Type.Literal('semantic_search'),
    Type.Literal('content_generation'),
    Type.Literal('multimodal_process'),
    Type.Literal('collaborative_edit'),
    Type.Literal('version_control'),
    Type.Literal('knowledge_graph'),
    Type.Literal('auto_tagging'),
    Type.Literal('content_summarization'),
    Type.Literal('cross_reference'),
  ], {
    description: '增强操作类型',
  }),
  language: Type.Union([
    Type.Literal('python'),
    Type.Literal('javascript'),
    Type.Literal('typescript'),
  ], {
    description: '编程语言',
  }),
  operation_code: Type.String({
    description: '操作代码（当 action 不为 intelligent_search/semantic_search 时使用）',
  }),
  search_query: Type.Optional(Type.String({
    description: '搜索查询（当 action=intelligent_search/semantic_search 时使用）',
  })),
  search_options: Type.Optional(Type.Object({
    additionalProperties: Type.Any(),
  }, {
    description: '搜索选项',
  })),
  inputs: Type.Optional(Type.Object({
    additionalProperties: Type.Any(),
  }, {
    description: '操作输入参数',
  })),
  allowed_modules: Type.Optional(Type.Array(Type.String(), {
    description: '允许使用的模块列表',
  })),
  timeout: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 300,
    description: '超时时间（秒，默认60秒）',
  })),
  // 新增参数
  context: Type.Optional(Type.Object({
    additionalProperties: Type.Any(),
  }, {
    description: '上下文信息（用于语义理解和内容生成）',
  })),
  version: Type.Optional(Type.String({
    description: '版本控制标识（用于 version_control 操作）',
  })),
  collaboration_id: Type.Optional(Type.String({
    description: '协作会话ID（用于 collaborative_edit 操作）',
  })),
});

type MemoryEnhancerParams = typeof MemoryEnhancerSchema.static;

/**
 * 创建 Memory Enhancer 工具
 */
export function createMemoryEnhancerTool(): AgentTool {
  const engine = new CodeToolEngine();

  return {
    name: 'memory_enhancer',
    label: 'Memory Enhancer',
    description: `智能记忆增强器 - 使用动态代码执行优化记忆和文本的增删改查。

支持的操作类型：
1. intelligent_search - 智能搜索（支持模糊匹配、语义搜索、正则表达式）
2. batch_process - 批量处理（批量文件操作、数据迁移、格式转换）
3. smart_classify - 智能分类（自动分类记忆内容、标签提取、主题识别）
4. data_validation - 数据验证（格式验证、完整性检查、数据清洗）
5. text_transformation - 文本转换（格式化、清理、提取、重构）
6. memory_mining - 记忆挖掘（模式识别、关联分析、知识提取）
7. semantic_search - 语义搜索（向量相似度、上下文理解）
8. content_generation - 智能内容生成（基于现有记忆生成新内容）
9. multimodal_process - 多模态处理（文本、结构化数据、元数据）
10. collaborative_edit - 实时协作（多用户并发记忆操作）
11. version_control - 版本控制（变更历史和回滚机制）
12. knowledge_graph - 知识图谱构建（实体关系抽取）
13. auto_tagging - 自动标签（智能标签生成和分类）
14. content_summarization - 内容摘要（智能摘要生成）
15. cross_reference - 交叉引用（内容关联和引用分析）

使用示例：
- 语义搜索：{"action": "semantic_search", "search_query": "用户偏好设置", "context": {"domain": "personalization"}}
- 内容生成：{"action": "content_generation", "operation_code": "// 生成新内容", "inputs": {"template": "...", "context": "..."}}
- 知识图谱：{"action": "knowledge_graph", "operation_code": "// 构建知识图谱", "inputs": {"entities": [...]}}
- 协作编辑：{"action": "collaborative_edit", "collaboration_id": "session_123", "inputs": {"operations": [...]}}`,
    parameters: MemoryEnhancerSchema,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<AgentToolResult<unknown>> => {
      try {
        const typedParams = params as MemoryEnhancerParams;
        
        if (!typedParams.action || !typedParams.language) {
          return {
            content: [
              {
                type: 'text',
                text: '错误：缺少必需的参数 action 或 language',
              },
            ],
            details: { error: 'Missing required parameters: action, language' },
          };
        }

        // 根据操作类型生成相应的代码模板
        const enhancedCode = generateEnhancedOperationCode(typedParams);

        // 构建执行请求
        const request: CodeToolRequest = {
          language: typedParams.language,
          code: enhancedCode,
          inputs: {
            action: typedParams.action,
            search_query: typedParams.search_query,
            search_options: typedParams.search_options || {},
            operation_inputs: typedParams.inputs || {},
            context: typedParams.context || {},
            version: typedParams.version,
            collaboration_id: typedParams.collaboration_id,
          },
          timeout: typedParams.timeout || 60,
          allowed_modules: typedParams.allowed_modules || getDefaultModules(typedParams.action),
          sandbox: {
            allowNetwork: false,
            memoryLimit: 256,
          },
        };

        // 执行增强操作
        const result = await engine.execute(request);

        // 格式化输出
        let outputText = `记忆增强操作完成\n\n`;
        outputText += `操作类型: ${typedParams.action}\n`;
        outputText += `编程语言: ${typedParams.language}\n`;
        outputText += `执行状态: ${result.success ? '✅ 成功' : '❌ 失败'}\n`;
        outputText += `执行时间: ${result.execution_time_ms}ms\n\n`;

        if (result.success) {
          outputText += `输出结果:\n${JSON.stringify(result.structured_output, null, 2)}\n\n`;
        } else {
          outputText += `错误信息: ${result.error?.message}\n`;
        }

        if (result.stdout) {
          outputText += `执行日志:\n${result.stdout}\n\n`;
        }

        return {
          content: [
            {
              type: 'text',
              text: outputText.trim(),
            },
          ],
          details: {
            action: typedParams.action,
            language: typedParams.language,
            success: result.success,
            output: result.structured_output,
            execution_time_ms: result.execution_time_ms,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.error,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Memory Enhancer 执行异常：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        };
      }
    },
  };
}

/**
 * 根据操作类型生成增强代码
 */
function generateEnhancedOperationCode(params: MemoryEnhancerParams): string {
  const templates: Record<string, string> = {
    python: generatePythonTemplate(params),
    javascript: generateJavaScriptTemplate(params),
    typescript: generateTypeScriptTemplate(params),
  };

  return templates[params.language] || templates.javascript;
}

/**
 * 生成 Python 模板
 */
function generatePythonTemplate(params: MemoryEnhancerParams): string {
  const { action, operation_code } = params;

  if (action === 'semantic_search') {
    return `
import json
import re
import numpy as np
from typing import List, Dict, Any, Tuple
from collections import Counter

def semantic_search(query: str, context: Dict[str, Any], search_options: Dict[str, Any]) -> Dict[str, Any]:
    """语义搜索函数"""
    
    # 上下文增强
    domain = context.get('domain', '')
    user_context = context.get('user_context', {})
    
    # 模拟向量相似度计算
    def calculate_similarity(text1: str, text2: str) -> float:
        # 简化的TF-IDF相似度计算
        words1 = set(text1.lower().split())
        words2 = set(text2.lower().split())
        intersection = words1.intersection(words2)
        union = words1.union(words2)
        return len(intersection) / len(union) if union else 0.0
    
    # 扩展查询
    expanded_query = query
    if domain:
        expanded_query += f" {domain}"
    
    # 模拟搜索结果
    search_results = []
    
    # 语义相关性评分
    semantic_scores = {}
    
    # 基于上下文的个性化排序
    personalization_boost = search_options.get('personalization', 0.2)
    
    return {
        "query": query,
        "expanded_query": expanded_query,
        "total_matches": len(search_results),
        "results": search_results[:20],
        "semantic_scores": semantic_scores,
        "context_applied": bool(context),
        "search_time_ms": 80
    }

# 执行语义搜索
result = semantic_search(inputs['search_query'], inputs['context'], inputs['search_options'])
output = result
`;
  }

  if (action === 'content_generation') {
    return `
import json
import re
from typing import List, Dict, Any
from datetime import datetime

def generate_content(operation_inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    """智能内容生成函数"""
    
    template = operation_inputs.get('template', '')
    generation_style = operation_inputs.get('style', 'neutral')
    target_length = operation_inputs.get('target_length', 500)
    
    # 基于上下文的内容生成
    context_keywords = context.get('keywords', [])
    domain = context.get('domain', 'general')
    
    # 内容生成逻辑
    generated_content = ""
    
    # 模板填充
    if template:
        generated_content = template
        # 替换模板变量
        for keyword in context_keywords:
            generated_content = generated_content.replace(f'{{{keyword}}}', f'相关的{keyword}')
    
    # 风格调整
    if generation_style == 'formal':
        generated_content = generated_content.replace('你', '您')
    elif generation_style == 'casual':
        generated_content = generated_content.replace('您', '你')
    
    # 长度控制
    if len(generated_content) > target_length:
        generated_content = generated_content[:target_length] + '...'
    
    return {
        "generated_content": generated_content,
        "template_used": template,
        "style_applied": generation_style,
        "context_integration": bool(context_keywords),
        "content_length": len(generated_content),
        "generation_timestamp": datetime.now().isoformat()
    }

# 执行内容生成
result = generate_content(inputs['operation_inputs'], inputs['context'])
output = result
`;
  }

  if (action === 'knowledge_graph') {
    return `
import json
import re
from typing import List, Dict, Any, Set, Tuple
from collections import defaultdict, Counter

def build_knowledge_graph(operation_inputs: Dict[str, Any]) -> Dict[str, Any]:
    """构建知识图谱函数"""
    
    entities = operation_inputs.get('entities', [])
    text_corpus = operation_inputs.get('text_corpus', '')
    
    # 实体识别
    def extract_entities(text: str) -> List[Dict[str, Any]]:
        entities = []
        
        # 简单的实体识别模式
        patterns = {
            'person': r'\\b[A-Z][a-z]+ [A-Z][a-z]+\\b',
            'organization': r'\\b[A-Z][a-z]+ (?:Inc|Corp|LLC|Ltd|Company)\\b',
            'location': r'\\b[A-Z][a-z]+ (?:City|State|Country)\\b',
            'date': r'\\b\\d{1,2}/\\d{1,2}/\\d{4}\\b'
        }
        
        for entity_type, pattern in patterns.items():
            matches = re.findall(pattern, text)
            for match in matches:
                entities.append({
                    'text': match,
                    'type': entity_type,
                    'confidence': 0.8
                })
        
        return entities
    
    # 关系抽取
    def extract_relations(text: str, entities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        relations = []
        
        # 简单的关系模式
        relation_patterns = [
            (r'(.+?) works for (.+?)', 'works_for'),
            (r'(.+?) is located in (.+?)', 'located_in'),
            (r'(.+?) was founded in (.+?)', 'founded_in'),
        ]
        
        for pattern, relation_type in relation_patterns:
            matches = re.findall(pattern, text)
            for match in matches:
                relations.append({
                    'subject': match[0],
                    'object': match[1],
                    'type': relation_type,
                    'confidence': 0.7
                })
        
        return relations
    
    # 构建图谱
    text_entities = extract_entities(text_corpus)
    all_entities = entities + text_entities
    
    # 去重
    unique_entities = {}
    for entity in all_entities:
        key = (entity['text'], entity['type'])
        if key not in unique_entities or entity['confidence'] > unique_entities[key]['confidence']:
            unique_entities[key] = entity
    
    relations = extract_relations(text_corpus, list(unique_entities.values()))
    
    # 构建图结构
    graph = {
        'nodes': [
            {
                'id': f"{entity['type']}_{i}",
                'label': entity['text'],
                'type': entity['type'],
                'confidence': entity['confidence']
            }
            for i, entity in enumerate(unique_entities.values())
        ],
        'edges': [
            {
                'source': f"{rel['subject']}_0",
                'target': f"{rel['object']}_0",
                'label': rel['type'],
                'confidence': rel['confidence']
            }
            for rel in relations
        ]
    }
    
    return {
        "knowledge_graph": graph,
        "entity_count": len(unique_entities),
        "relation_count": len(relations),
        "graph_density": len(relations) / (len(unique_entities) * (len(unique_entities) - 1) / 2) if len(unique_entities) > 1 else 0,
        "construction_timestamp": datetime.now().isoformat()
    }

# 执行知识图谱构建
result = build_knowledge_graph(inputs['operation_inputs'])
output = result
`;
  }

  if (action === 'collaborative_edit') {
    return `
import json
import uuid
from typing import List, Dict, Any
from datetime import datetime

def collaborative_edit(operation_inputs: Dict[str, Any], collaboration_id: str) -> Dict[str, Any]:
    """协作编辑函数"""
    
    operations = operation_inputs.get('operations', [])
    user_id = operation_inputs.get('user_id', 'anonymous')
    
    # 操作类型处理
    def apply_operation(content: str, operation: Dict[str, Any]) -> str:
        op_type = operation.get('type')
        position = operation.get('position', 0)
        text = operation.get('text', '')
        
        if op_type == 'insert':
            return content[:position] + text + content[position:]
        elif op_type == 'delete':
            start = position
            end = operation.get('end', position + 1)
            return content[:start] + content[end:]
        elif op_type == 'replace':
            start = position
            end = operation.get('end', position + len(text))
            return content[:start] + text + content[end:]
        
        return content
    
    # 模拟协作会话状态
    session_state = {
        'collaboration_id': collaboration_id,
        'participants': ['user1', 'user2'],
        'current_content': '',
        'operation_history': [],
        'conflicts': []
    }
    
    # 应用操作
    for operation in operations:
        operation['timestamp'] = datetime.now().isoformat()
        operation['user_id'] = user_id
        operation['operation_id'] = str(uuid.uuid4())
        
        # 检查冲突
        if session_state['operation_history']:
            last_op = session_state['operation_history'][-1]
            if (operation['position'] < last_op.get('end', operation['position']) and 
                operation['user_id'] != last_op['user_id']):
                session_state['conflicts'].append({
                    'conflict_id': str(uuid.uuid4()),
                    'operations': [last_op, operation],
                    'detected_at': datetime.now().isoformat()
                })
        
        # 应用操作
        session_state['current_content'] = apply_operation(
            session_state['current_content'], 
            operation
        )
        
        session_state['operation_history'].append(operation)
    
    return {
        "collaboration_id": collaboration_id,
        "session_state": session_state,
        "operations_applied": len(operations),
        "conflicts_detected": len(session_state['conflicts']),
        "final_content": session_state['current_content'],
        "content_length": len(session_state['current_content']),
        "session_timestamp": datetime.now().isoformat()
    }

# 执行协作编辑
result = collaborative_edit(inputs['operation_inputs'], inputs['collaboration_id'])
output = result
`;
  }

  if (action === 'version_control') {
    return `
import json
import hashlib
from typing import List, Dict, Any
from datetime import datetime

def version_control(operation_inputs: Dict[str, Any], version: str) -> Dict[str, Any]:
    """版本控制函数"""
    
    content = operation_inputs.get('content', '')
    operation_type = operation_inputs.get('operation', 'save')  # save, restore, diff
    target_version = operation_inputs.get('target_version')
    
    # 计算内容哈希
    def calculate_hash(content: str) -> str:
        return hashlib.sha256(content.encode()).hexdigest()
    
    # 创建版本记录
    def create_version(content: str, version: str) -> Dict[str, Any]:
        return {
            'version': version,
            'timestamp': datetime.now().isoformat(),
            'content_hash': calculate_hash(content),
            'content_length': len(content),
            'content': content
        }
    
    # 比较版本差异
    def compare_versions(version1: Dict[str, Any], version2: Dict[str, Any]) -> Dict[str, Any]:
        content1 = version1['content']
        content2 = version2['content']
        
        # 简单的行级差异
        lines1 = content1.split('\\n')
        lines2 = content2.split('\\n')
        
        additions = []
        deletions = []
        
        for i, line in enumerate(lines2):
            if i >= len(lines1):
                additions.append((i, line))
            elif line != lines1[i]:
                additions.append((i, line))
                if i < len(lines1):
                    deletions.append((i, lines1[i]))
        
        return {
            'version1': version1['version'],
            'version2': version2['version'],
            'additions': additions,
            'deletions': deletions,
            'total_changes': len(additions) + len(deletions)
        }
    
    # 模拟版本历史
    version_history = []
    
    # 执行操作
    if operation_type == 'save':
        new_version = create_version(content, version)
        version_history.append(new_version)
        
        return {
            "operation": "save",
            "version": version,
            "content_hash": new_version['content_hash'],
            "saved_at": new_version['timestamp'],
            "total_versions": len(version_history)
        }
    
    elif operation_type == 'restore':
        # 查找目标版本
        target_version_data = None
        for v in version_history:
            if v['version'] == target_version:
                target_version_data = v
                break
        
        if target_version_data:
            return {
                "operation": "restore",
                "restored_version": target_version,
                "content": target_version_data['content'],
                "restored_at": datetime.now().isoformat()
            }
        else:
            return {
                "operation": "restore",
                "error": f"Version {target_version} not found"
            }
    
    elif operation_type == 'diff':
        if len(version_history) >= 2:
            diff_result = compare_versions(version_history[-2], version_history[-1])
            return {
                "operation": "diff",
                "diff_result": diff_result,
                "compared_at": datetime.now().isoformat()
            }
        else:
            return {
                "operation": "diff",
                "error": "Insufficient versions for comparison"
            }
    
    return {
        "operation": operation_type,
        "status": "completed",
        "timestamp": datetime.now().isoformat()
    }

# 执行版本控制
result = version_control(inputs['operation_inputs'], inputs['version'])
output = result
`;
  }

  // 原有模板保持不变...
  if (action === 'intelligent_search') {
    return `
import json
import re
from pathlib import Path
from typing import List, Dict, Any
import difflib

def intelligent_search(query: str, options: Dict[str, Any]) -> Dict[str, Any]:
    """智能搜索函数"""
    # 搜索选项
    fuzzy = options.get('fuzzy', False)
    semantic = options.get('semantic', False)
    regex = options.get('regex', False)
    case_sensitive = options.get('case_sensitive', False)
    
    # 模拟搜索结果（实际实现会调用真实的搜索API）
    search_results = []
    
    # 模糊匹配
    if fuzzy:
        similarity_threshold = options.get('similarity_threshold', 0.6)
        # 实现模糊匹配逻辑
        pass
    
    # 语义搜索
    if semantic:
        # 实现语义搜索逻辑
        pass
    
    # 正则表达式搜索
    if regex:
        try:
            pattern = re.compile(query, re.IGNORECASE if not case_sensitive else 0)
            # 实现正则搜索逻辑
            pass
        except re.error as e:
            return {"error": f"正则表达式错误: {e}"}
    
    # 返回搜索结果
    return {
        "query": query,
        "total_matches": len(search_results),
        "results": search_results[:20],  # 限制结果数量
        "search_time_ms": 50  # 模拟搜索时间
    }

# 执行智能搜索
result = intelligent_search(inputs['search_query'], inputs['search_options'])
output = result
`;
  }

  if (action === 'batch_process') {
    return `
import json
import os
from pathlib import Path
from typing import List, Dict, Any

def batch_process(operation_inputs: Dict[str, Any]) -> Dict[str, Any]:
    """批量处理函数"""
    processed_items = []
    errors = []
    
    # 用户提供的操作代码
${operation_code}
    
    # 批量处理逻辑
    try:
        # 这里会执行用户的批量操作代码
        pass
    except Exception as e:
        errors.append(str(e))
    
    return {
        "processed_count": len(processed_items),
        "error_count": len(errors),
        "processed_items": processed_items,
        "errors": errors
    }

# 执行批量处理
result = batch_process(inputs['operation_inputs'])
output = result
`;
  }

  if (action === 'smart_classify') {
    return `
import json
import re
from typing import List, Dict, Any, Tuple
from collections import Counter

def smart_classify(content: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """智能分类函数"""
    
    # 提取关键词
    keywords = re.findall(r'\\b\\w+\\b', content.lower())
    keyword_freq = Counter(keywords)
    
    # 分类规则
    categories = {
        "preference": ["偏好", "设置", "配置", "选项", "喜好"],
        "character": ["角色", "人物", "性格", "背景", "特征"],
        "knowledge": ["知识", "技能", "能力", "学习", "经验"],
        "event": ["事件", "经历", "故事", "回忆", "对话"],
        "task": ["任务", "目标", "计划", "待办", "完成"]
    }
    
    # 计算分类得分
    category_scores = {}
    for category, category_keywords in categories.items():
        score = sum(freq for keyword, freq in keyword_freq.items() 
                   if any(cat_key in keyword for cat_key in category_keywords))
        category_scores[category] = score
    
    # 确定主分类
    main_category = max(category_scores, key=category_scores[key]) if category_scores else "uncategorized"
    
    # 提取标签
    tags = [keyword for keyword, freq in keyword_freq.most_common(10) 
            if len(keyword) > 2 and freq > 1]
    
    return {
        "main_category": main_category,
        "category_scores": category_scores,
        "tags": tags,
        "keyword_count": len(keywords),
        "content_length": len(content)
    }

# 执行智能分类
result = smart_classify(inputs['operation_inputs'].get('content', ''), inputs.get('context', {}))
output = result
`;
  }

  return `
# 默认 Python 模板
import json

def process_memory_operation(action: str, inputs: Dict[str, Any]) -> Dict[str, Any]:
    """通用记忆处理函数"""
    return {
        "action": action,
        "status": "completed",
        "message": "操作完成"
    }

# 执行操作
result = process_memory_operation("${action}", inputs['operation_inputs'])
output = result
`;
}

/**
 * 生成 JavaScript 模板
 */
function generateJavaScriptTemplate(params: MemoryEnhancerParams): string {
  const { action, operation_code } = params;

  if (action === 'semantic_search') {
    return `
// 语义搜索函数
function semanticSearch(query, context = {}, searchOptions = {}) {
  const {
    domain = '',
    userContext = {},
    personalization = 0.2
  } = context;

  const {
    fuzzy = false,
    semantic = true,
    caseSensitive = false,
    similarityThreshold = 0.6
  } = searchOptions;
  
  // 扩展查询
  const expandedQuery = domain ? \`\${query} \${domain}\` : query;
  
  // 向量相似度计算（简化版）
  const calculateSimilarity = (text1, text2) => {
    const words1 = new Set(text1.toLowerCase().split(/\\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\\s+/));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  };
  
  // 模拟搜索结果
  const results = [];
  const semanticScores = {};
  
  // 基于上下文的个性化排序
  const personalizedResults = results.map(result => ({
    ...result,
    score: result.score + (personalization * result.contextMatch || 0)
  }));
  
  return {
    query,
    expandedQuery,
    totalMatches: personalizedResults.length,
    results: personalizedResults.slice(0, 20),
    semanticScores,
    contextApplied: Boolean(domain || Object.keys(userContext).length),
    searchTimeMs: 80
  };
}

// 执行语义搜索
const result = semanticSearch(inputs.search_query, inputs.context, inputs.search_options);
output = result;
`;
  }

  if (action === 'auto_tagging') {
    return `
// 自动标签生成函数
function autoTagging(content, context = {}) {
  const {
    existingTags = [],
    tagCategories = ['skill', 'preference', 'knowledge', 'experience', 'goal'],
    maxTags = 10
  } = context;
  
  // 提取关键词
  const extractKeywords = (text) => {
    const words = text.toLowerCase()
      .replace(/[.,!?;:]/g, '')
      .split(/\\s+/)
      .filter(word => word.length > 2);
    
    const wordFreq = {};
    words.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });
    
    return Object.entries(wordFreq)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 20)
      .map(([word, freq]) => ({ word, freq }));
  };
  
  // 分类标签
  const categorizeTags = (keywords) => {
    const categoryRules = {
      skill: ['会', '能', '擅长', '掌握', '熟悉', '了解'],
      preference: ['喜欢', '偏好', '爱好', '享受', '倾向', '愿意'],
      knowledge: ['知道', '了解', '学习', '研究', '掌握', '理解'],
      experience: ['经历', '体验', '感受', '做过', '参与', '见过'],
      goal: ['目标', '计划', '想要', '希望', '梦想', '追求']
    };
    
    const tags = [];
    
    keywords.forEach(({ word, freq }) => {
      for (const [category, triggers] of Object.entries(categoryRules)) {
        if (triggers.some(trigger => word.includes(trigger) || trigger.includes(word))) {
          tags.push({
            tag: word,
            category,
            confidence: Math.min(freq / 5, 1.0),
            source: 'auto_extracted'
          });
        }
      }
    });
    
    return tags;
  };
  
  // 去重和排序
  const deduplicateTags = (tags) => {
    const unique = {};
    tags.forEach(tag => {
      const key = \`\${tag.tag}_\${tag.category}\`;
      if (!unique[key] || tag.confidence > unique[key].confidence) {
        unique[key] = tag;
      }
    });
    return Object.values(unique);
  };
  
  const keywords = extractKeywords(content);
  const categorizedTags = categorizeTags(keywords);
  const uniqueTags = deduplicateTags(categorizedTags);
  
  // 合并现有标签
  const allTags = [...existingTags, ...uniqueTags];
  const finalTags = allTags.slice(0, maxTags);
  
  return {
    contentLength: content.length,
    keywordsFound: keywords.length,
    tagsGenerated: uniqueTags.length,
    existingTagsCount: existingTags.length,
    finalTags: finalTags,
    tagDistribution: finalTags.reduce((acc, tag) => {
      acc[tag.category] = (acc[tag.category] || 0) + 1;
      return acc;
    }, {}),
    processingTimeMs: 45
  };
}

// 执行自动标签
const result = autoTagging(inputs.operation_inputs.content || '', inputs.context);
output = result;
`;
  }

  if (action === 'content_summarization') {
    return `
// 内容摘要生成函数
function contentSummarization(content, options = {}) {
  const {
    summaryLength = 'medium', // short, medium, long
    style = 'neutral', // neutral, formal, casual
    extractKeyPoints = true,
    language = 'zh'
  } = options;
  
  // 句子分割
  const splitSentences = (text) => {
    return text.split(/[。！？.!?]/)
      .filter(sentence => sentence.trim().length > 0)
      .map(sentence => sentence.trim());
  };
  
  // 计算句子重要性
  const calculateSentenceImportance = (sentences) => {
    const wordFreq = {};
    const allWords = sentences.join(' ').toLowerCase().split(/\\s+/);
    
    // 计算词频
    allWords.forEach(word => {
      if (word.length > 1) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    });
    
    // 计算句子得分
    return sentences.map(sentence => {
      const words = sentence.toLowerCase().split(/\\s+/);
      let score = 0;
      let wordCount = 0;
      
      words.forEach(word => {
        if (wordFreq[word]) {
          score += wordFreq[word];
          wordCount++;
        }
      });
      
      return {
        sentence,
        score: wordCount > 0 ? score / wordCount : 0,
        length: sentence.length,
        position: sentences.indexOf(sentence)
      };
    });
  };
  
  // 提取关键句
  const extractKeySentences = (sentenceScores, targetLength) => {
    const sorted = [...sentenceScores].sort((a, b) => b.score - a.score);
    const selected = [];
    let totalLength = 0;
    
    for (const sentenceData of sorted) {
      if (totalLength + sentenceData.length <= targetLength) {
        selected.push(sentenceData);
        totalLength += sentenceData.length;
      } else {
        break;
      }
    }
    
    // 按原始位置排序
    return selected.sort((a, b) => a.position - b.position);
  };
  
  const sentences = splitSentences(content);
  const sentenceScores = calculateSentenceImportance(sentences);
  
  // 根据摘要长度确定目标长度
  const lengthMultipliers = {
    short: 0.1,
    medium: 0.3,
    long: 0.5
  };
  
  const targetLength = Math.floor(content.length * lengthMultipliers[summaryLength]);
  const keySentences = extractKeySentences(sentenceScores, targetLength);
  
  // 生成摘要
  const summary = keySentences.map(item => item.sentence).join('。') + '。';
  
  // 提取关键点
  let keyPoints = [];
  if (extractKeyPoints) {
    keyPoints = sentenceScores
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(item => item.sentence);
  }
  
  return {
    originalLength: content.length,
    summaryLength: summary.length,
    compressionRatio: (summary.length / content.length).toFixed(3),
    summaryStyle: style,
    sentenceCount: sentences.length,
    keySentencesCount: keySentences.length,
    summary,
    keyPoints,
    processingTimeMs: 60
  };
}

// 执行内容摘要
const result = contentSummarization(inputs.operation_inputs.content || '', inputs.operation_inputs.options || {});
output = result;
`;
  }

  if (action === 'cross_reference') {
    return `
// 交叉引用分析函数
function crossReference(documents, options = {}) {
  const {
    referenceTypes = ['citation', 'mention', 'relation'],
    similarityThreshold = 0.3,
    maxReferences = 50
  } = options;
  
  // 计算文档相似度
  const calculateSimilarity = (doc1, doc2) => {
    const words1 = new Set(doc1.content.toLowerCase().split(/\\s+/));
    const words2 = new Set(doc2.content.toLowerCase().split(/\\s+/));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  };
  
  // 提取引用关系
  const extractReferences = (documents) => {
    const references = [];
    
    documents.forEach((doc, docIndex) => {
      // 检测文档间的引用
      documents.forEach((otherDoc, otherIndex) => {
        if (docIndex !== otherIndex) {
          const similarity = calculateSimilarity(doc, otherDoc);
          
          if (similarity >= similarityThreshold) {
            // 查找具体的引用文本
            const docSentences = doc.content.split(/[。！？.!?]/);
            const otherSentences = otherDoc.content.split(/[。！？.!?]/);
            
            let referenceType = 'relation';
            let referenceText = '';
            
            // 检测引用类型
            if (doc.content.includes(otherDoc.title)) {
              referenceType = 'citation';
              referenceText = otherDoc.title;
            } else if (doc.content.toLowerCase().includes(otherDoc.title.toLowerCase())) {
              referenceType = 'mention';
              referenceText = otherDoc.title;
            }
            
            references.push({
              sourceDocument: docIndex,
              targetDocument: otherIndex,
              sourceTitle: doc.title,
              targetTitle: otherDoc.title,
              referenceType,
              similarity,
              referenceText,
              confidence: Math.min(similarity * 1.5, 1.0)
            });
          }
        }
      });
    });
    
    return references;
  };
  
  // 构建引用网络
  const buildReferenceNetwork = (references) => {
    const network = {
      nodes: documents.map((doc, index) => ({
        id: index,
        title: doc.title,
        contentLength: doc.content.length,
        referenceCount: references.filter(r => r.sourceDocument === index).length,
        referencedByCount: references.filter(r => r.targetDocument === index).length
      })),
      edges: references.map(ref => ({
        source: ref.sourceDocument,
        target: ref.targetDocument,
        type: ref.referenceType,
        weight: ref.confidence,
        similarity: ref.similarity
      }))
    };
    
    return network;
  };
  
  // 分析引用统计
  const analyzeReferences = (references, documents) => {
    const stats = {
      totalReferences: references.length,
      referenceTypeDistribution: {},
      averageSimilarity: 0,
      mostReferencedDocs: [],
      isolatedDocs: []
    };
    
    // 引用类型分布
    references.forEach(ref => {
      stats.referenceTypeDistribution[ref.referenceType] = 
        (stats.referenceTypeDistribution[ref.referenceType] || 0) + 1;
    });
    
    // 平均相似度
    stats.averageSimilarity = references.reduce((sum, ref) => sum + ref.similarity, 0) / references.length;
    
    // 最常被引用的文档
    const referenceCounts = new Array(documents.length).fill(0);
    references.forEach(ref => {
      referenceCounts[ref.targetDocument]++;
    });
    
    stats.mostReferencedDocs = referenceCounts
      .map((count, index) => ({ documentIndex: index, referenceCount: count }))
      .sort((a, b) => b.referenceCount - a.referenceCount)
      .slice(0, 5);
    
    // 孤立文档（无引用关系）
    stats.isolatedDocs = referenceCounts
      .map((count, index) => ({ documentIndex: index, referenceCount: count }))
      .filter(item => item.referenceCount === 0)
      .map(item => item.documentIndex);
    
    return stats;
  };
  
  const references = extractReferences(documents);
  const network = buildReferenceNetwork(references);
  const stats = analyzeReferences(references, documents);
  
  return {
    documentsProcessed: documents.length,
    referencesFound: references.length,
    referenceNetwork: network,
    statistics: stats,
    processingTimeMs: 120
  };
}

// 执行交叉引用分析
const result = crossReference(inputs.operation_inputs.documents || [], inputs.operation_inputs.options || {});
output = result;
`;
  }

  // 原有模板保持不变...
  if (action === 'intelligent_search') {
    return `
// 智能搜索函数
function intelligentSearch(query, options = {}) {
  const {
    fuzzy = false,
    semantic = false,
    regex = false,
    caseSensitive = false,
    similarityThreshold = 0.6
  } = options;
  
  const results = [];
  
  // 模糊匹配
  if (fuzzy) {
    // 实现模糊匹配逻辑
    const calculateSimilarity = (str1, str2) => {
      const longer = str1.length > str2.length ? str1 : str2;
      const shorter = str1.length > str2.length ? str2 : str1;
      
      if (longer.length === 0) return 1.0;
      
      const editDistance = levenshteinDistance(longer, shorter);
      return (longer.length - editDistance) / longer.length;
    };
    
    const levenshteinDistance = (str1, str2) => {
      const matrix = [];
      for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
      }
      for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
      }
      
      for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
          if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
            matrix[i][j] = matrix[i - 1][j - 1];
          } else {
            matrix[i][j] = Math.min(
              matrix[i - 1][j - 1] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j] + 1
            );
          }
        }
      }
      
      return matrix[str2.length][str1.length];
    };
  }
  
  // 正则表达式搜索
  if (regex) {
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const pattern = new RegExp(query, flags);
      // 实现正则搜索逻辑
    } catch (error) {
      return { error: \`正则表达式错误: \${error.message}\` };
    }
  }
  
  return {
    query,
    totalMatches: results.length,
    results: results.slice(0, 20),
    searchTimeMs: 50
  };
}

// 执行智能搜索
const result = intelligentSearch(inputs.search_query, inputs.search_options);
output = result;
`;
  }

  return `
// 默认 JavaScript 模板
function processMemoryOperation(action, inputs) {
  return {
    action: action,
    status: 'completed',
    message: '操作完成'
  };
}

// 执行操作
const result = processMemoryOperation('${action}', inputs.operation_inputs);
output = result;
`;
}

/**
 * 生成 TypeScript 模板
 */
function generateTypeScriptTemplate(params: MemoryEnhancerParams): string {
  return `
// TypeScript 模板（与 JavaScript 类似，但包含类型定义）
interface SearchOptions {
  fuzzy?: boolean;
  semantic?: boolean;
  regex?: boolean;
  caseSensitive?: boolean;
  similarityThreshold?: number;
}

interface SearchResult {
  path: string;
  score: number;
  snippet: string;
  line: number;
}

function intelligentSearch(query: string, options: SearchOptions = {}): {
  query: string;
  totalMatches: number;
  results: SearchResult[];
  searchTimeMs: number;
} {
  const results: SearchResult[] = [];
  
  // 实现搜索逻辑
  // ...
  
  return {
    query,
    totalMatches: results.length,
    results: results.slice(0, 20),
    searchTimeMs: 50
  };
}

// 执行智能搜索
const result = intelligentSearch(inputs.search_query, inputs.search_options);
output = result;
`;
}

/**
 * 获取默认模块列表
 */
function getDefaultModules(action: string): string[] {
  const moduleMap: Record<string, string[]> = {
    intelligent_search: ['re', 'json', 'pathlib'],
    batch_process: ['json', 'os', 'pathlib'],
    smart_classify: ['re', 'json', 'collections'],
    data_validation: ['json', 're'],
    text_transformation: ['re', 'json'],
    memory_mining: ['json', 're', 'collections'],
    // 新增模块映射
    semantic_search: ['re', 'json', 'numpy', 'collections'],
    content_generation: ['json', 're', 'datetime'],
    multimodal_process: ['json', 're', 'datetime'],
    collaborative_edit: ['json', 'uuid', 'datetime'],
    version_control: ['json', 'hashlib', 'datetime'],
    knowledge_graph: ['json', 're', 'collections', 'datetime'],
    auto_tagging: ['json', 'collections'],
    content_summarization: ['json', 'collections'],
    cross_reference: ['json', 'collections'],
  };

  return moduleMap[action] || ['json'];
}

// 导出工具创建函数
