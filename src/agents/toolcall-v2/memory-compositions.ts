/**
 * OpenCAWD ToolCall 2.0 - Memory Compositions
 * 
 * 预定义的记忆增强组合模板
 * 
 * 新增功能：
 * - 智能记忆管理：自动分类、标签、索引
 * - 高级搜索工作流：多模态搜索、语义理解
 * - 内容创作流水线：基于记忆的内容生成
 * - 协作记忆系统：多用户实时协作
 * - 知识图谱构建：实体关系抽取和可视化
 */

import type { ToolCompositionConfig } from './tool-composer.js';

/**
 * 创建记忆增强组合模板
 */
export function createMemoryCompositions(): ToolCompositionConfig[] {
  return [
    {
      name: 'advanced_intelligent_search',
      description: '高级智能搜索工作流：语义搜索 → 模糊匹配 → 上下文理解 → 结果排序 → 相关性分析',
      language: 'python',
      composition_code: `
# 高级智能搜索工作流
import json
import re
from collections import defaultdict

async def advanced_intelligent_search(query, search_options, context):
    """高级智能搜索工作流"""
    
    # 步骤1: 语义搜索
    semantic_results = await call_tool('memory_enhancer', {
        'action': 'semantic_search',
        'language': 'python',
        'search_query': query,
        'search_options': {
            'fuzzy': True,
            'semantic': True,
            'context_aware': True,
            'similarity_threshold': 0.7
        },
        'context': context
    })
    
    # 步骤2: 模糊搜索
    fuzzy_results = await call_tool('memory_enhancer', {
        'action': 'intelligent_search',
        'language': 'python',
        'search_query': query,
        'search_options': {
            'fuzzy': True,
            'similarity_threshold': 0.6,
            'case_sensitive': False
        }
    })
    
    # 步骤3: 上下文增强搜索
    context_results = await call_tool('memory_enhancer', {
        'action': 'semantic_search',
        'language': 'python',
        'search_query': query,
        'search_options': {
            'personalization': 0.3,
            'domain_boost': 0.2
        },
        'context': context
    })
    
    # 步骤4: 结果融合和排序
    all_results = []
    for result_set in [semantic_results, fuzzy_results, context_results]:
        if result_set.get('results'):
            for result in result_set['results']:
                result['search_method'] = result_set.get('search_method', 'unknown')
                all_results.append(result)
    
    # 智能去重（基于路径相似度）
    def calculate_path_similarity(path1, path2):
        words1 = set(path1.lower().split('/'))
        words2 = set(path2.lower().split('/'))
        intersection = words1.intersection(words2)
        union = words1.union(words2)
        return len(intersection) / len(union) if union else 0
    
    unique_results = []
    for result in sorted(all_results, key=lambda x: x.get('score', 0), reverse=True):
        is_duplicate = False
        for existing in unique_results:
            if calculate_path_similarity(result.get('path', ''), existing.get('path', '')) > 0.8:
                is_duplicate = True
                break
        if not is_duplicate:
            unique_results.append(result)
    
    # 步骤5: 相关性分析
    analysis = {
        'query': query,
        'total_results': len(unique_results),
        'search_methods_used': ['semantic', 'fuzzy', 'context_aware'],
        'score_distribution': {
            'high': len([r for r in unique_results if r.get('score', 0) > 0.8]),
            'medium': len([r for r in unique_results if 0.5 < r.get('score', 0) <= 0.8]),
            'low': len([r for r in unique_results if r.get('score', 0) <= 0.5])
        },
        'method_effectiveness': {},
        'context_impact': len(context) > 0
    }
    
    # 分析各方法效果
    for result in unique_results[:10]:
        method = result.get('search_method', 'unknown')
        analysis['method_effectiveness'][method] = analysis['method_effectiveness'].get(method, 0) + 1
    
    return {
        'status': 'success',
        'query': query,
        'results': unique_results[:20],  # 返回前20个结果
        'analysis': analysis,
        'search_time_ms': 200,
        'context_applied': bool(context)
    }

# 执行高级搜索
result = advanced_intelligent_search(inputs['query'], inputs.get('search_options', {}), inputs.get('context', {}))
output = result
`,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          search_options: { type: 'object' },
          context: { type: 'object' },
        },
        required: ['query'],
      },
      allowed_tools: ['memory_enhancer'],
      timeout: 180,
    },
    {
      name: 'intelligent_content_creation_pipeline',
      description: '智能内容创作流水线：记忆分析 → 内容生成 → 质量评估 → 自动标签 → 版本保存',
      language: 'javascript',
      composition_code: `
// 智能内容创作流水线
async function intelligentContentCreationPipeline(params) {
  const {
    topic,
    content_type = 'article',
    style = 'neutral',
    target_length = 1000,
    context = {},
    use_memory = true
  } = params;
  
  const pipeline = {
    stages: {
      memory_analysis: { status: 'pending', duration: 0 },
      content_generation: { status: 'pending', duration: 0 },
      quality_assessment: { status: 'pending', duration: 0 },
      auto_tagging: { status: 'pending', duration: 0 },
      version_save: { status: 'pending', duration: 0 }
    },
    results: {},
    final_content: '',
    metadata: {}
  };
  
  try {
    // 阶段1: 记忆分析
    const startTime = Date.now();
    let memoryContext = {};
    
    if (use_memory) {
      const memoryAnalysis = await call_tool('memory_enhancer', {
        'action': 'semantic_search',
        'language': 'javascript',
        'search_query': topic,
        'search_options': { 'semantic': true, 'fuzzy': true },
        'context': { 'domain': content_type, 'style': style }
      });
      
      if (memoryAnalysis.success) {
        memoryContext = {
          relevant_memories: memoryAnalysis.results || [],
          topic_keywords: extractKeywords(memoryAnalysis.results || []),
          user_preferences: context.user_preferences || {}
        };
      }
    }
    
    pipeline.stages.memory_analysis.status = 'completed';
    pipeline.stages.memory_analysis.duration = Date.now() - startTime;
    
    // 阶段2: 内容生成
    const genStartTime = Date.now();
    const contentGeneration = await call_tool('memory_enhancer', {
      'action': 'content_generation',
      'language': 'javascript',
      'operation_code': '// 内容生成逻辑',
      'inputs': {
        'template': buildTemplate(content_type, style),
        'style': style,
        'target_length': target_length,
        'topic': topic,
        'memory_context': memoryContext
      },
      'context': {
        'domain': content_type,
        'keywords': memoryContext.topic_keywords || []
      }
    });
    
    pipeline.stages.content_generation.status = contentGeneration.success ? 'completed' : 'failed';
    pipeline.stages.content_generation.duration = Date.now() - genStartTime;
    
    let generatedContent = '';
    if (contentGeneration.success) {
      generatedContent = contentGeneration.results.generated_content || '';
      pipeline.results.content_generation = contentGeneration.results;
    }
    
    // 阶段3: 质量评估
    const qaStartTime = Date.now();
    const qualityAssessment = await call_tool('memory_enhancer', {
      'action': 'data_validation',
      'language': 'javascript',
      'operation_code': '''
// 内容质量评估代码
function assessContentQuality(content, criteria) {
  const assessment = {
    readability: 0,
    coherence: 0,
    completeness: 0,
    style_consistency: 0,
    overall_score: 0,
    issues: [],
    suggestions: []
  };
  
  // 可读性评估
  const sentences = content.split(/[.!?。！？]/);
  const avgSentenceLength = sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length;
  assessment.readability = Math.max(0, 1 - (avgSentenceLength - 50) / 100);
  
  // 完整性评估
  const requiredElements = criteria.required_elements || [];
  assessment.completeness = requiredElements.filter(element => 
    content.toLowerCase().includes(element.toLowerCase())
  ).length / requiredElements.length;
  
  // 风格一致性
  const styleIndicators = criteria.style_indicators || {};
  let styleMatches = 0;
  for (const [indicator, expected] of Object.entries(styleIndicators)) {
    const pattern = new RegExp(indicator, 'gi');
    const matches = (content.match(pattern) || []).length;
    if ((expected && matches > 0) || (!expected && matches === 0)) {
      styleMatches++;
    }
  }
  assessment.style_consistency = styleMatches / Object.keys(styleIndicators).length;
  
  // 连贯性评估（简化版）
  const transitionWords = ['因此', '然而', '此外', '总之', '首先', '其次'];
  const transitionCount = transitionWords.filter(word => 
    content.includes(word)
  ).length;
  assessment.coherence = Math.min(1, transitionCount / 5);
  
  // 计算总分
  assessment.overall_score = (
    assessment.readability * 0.25 +
    assessment.coherence * 0.25 +
    assessment.completeness * 0.3 +
    assessment.style_consistency * 0.2
  );
  
  return assessment;
}
''',
      'inputs': {
        'content': generatedContent,
        'criteria': {
          'required_elements': [topic],
          'style_indicators': getStyleIndicators(style),
          'target_length': target_length
        }
      }
    });
    
    pipeline.stages.quality_assessment.status = qualityAssessment.success ? 'completed' : 'failed';
    pipeline.stages.quality_assessment.duration = Date.now() - qaStartTime;
    
    if (qualityAssessment.success) {
      pipeline.results.quality_assessment = qualityAssessment.results;
    }
    
    // 阶段4: 自动标签
    const taggingStartTime = Date.now();
    const autoTagging = await call_tool('memory_enhancer', {
      'action': 'auto_tagging',
      'language': 'javascript',
      'operation_code': '// 自动标签逻辑',
      'inputs': {
        'content': generatedContent
      },
      'context': {
        'existing_tags': context.existing_tags || [],
        'tag_categories': ['topic', 'style', 'content_type', 'quality']
      }
    });
    
    pipeline.stages.auto_tagging.status = autoTagging.success ? 'completed' : 'failed';
    pipeline.stages.auto_tagging.duration = Date.now() - taggingStartTime;
    
    if (autoTagging.success) {
      pipeline.results.auto_tagging = autoTagging.results;
    }
    
    // 阶段5: 版本保存
    const saveStartTime = Date.now();
    const versionSave = await call_tool('memory_enhancer', {
      'action': 'version_control',
      'language': 'javascript',
      'operation_code': '// 版本保存逻辑',
      'inputs': {
        'content': generatedContent,
        'operation': 'save'
      },
      'version': generateVersionId(content_type, topic)
    });
    
    pipeline.stages.version_save.status = versionSave.success ? 'completed' : 'failed';
    pipeline.stages.version_save.duration = Date.now() - saveStartTime;
    
    if (versionSave.success) {
      pipeline.results.version_save = versionSave.results;
    }
    
    // 构建最终结果
    const totalDuration = Object.values(pipeline.stages)
      .reduce((sum, stage) => sum + stage.duration, 0);
    
    pipeline.final_content = generatedContent;
    pipeline.metadata = {
      topic,
      content_type,
      style,
      target_length,
      actual_length: generatedContent.length,
      completion_rate: Object.values(pipeline.stages)
        .filter(stage => stage.status === 'completed').length / Object.keys(pipeline.stages).length,
      total_duration: totalDuration,
      quality_score: qualityAssessment.success ? qualityAssessment.results.overall_score : 0,
      tags_generated: autoTagging.success ? autoTagging.results.finalTags : [],
      version_id: versionSave.success ? versionSave.results.version : null
    };
    
    return {
      status: 'success',
      pipeline: pipeline,
      content: generatedContent,
      metadata: pipeline.metadata
    };
    
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      pipeline: pipeline
    };
  }
}

// 辅助函数
function extractKeywords(results) {
  const keywords = new Set();
  results.forEach(result => {
    if (result.snippet) {
      result.snippet.split(/\\s+/).forEach(word => {
        if (word.length > 2) keywords.add(word.toLowerCase());
      });
    }
  });
  return Array.from(keywords).slice(0, 20);
}

function buildTemplate(contentType, style) {
  const templates = {
    article: {
      neutral: "# {topic}\\n\\n## 引言\\n\\n## 正文\\n\\n## 结论",
      formal: "# 关于{topic}的分析\\n\\n## 概述\\n\\n## 详细分析\\n\\n## 总结",
      casual: "# {topic}聊聊\\n\\n## 开头\\n\\n## 中间\\n\\n## 收尾"
    }
  };
  
  return templates[contentType]?.[style] || templates.article.neutral;
}

function getStyleIndicators(style) {
  const indicators = {
    neutral: {
      formal_language: false,
      casual_expressions: false
    },
    formal: {
      formal_language: true,
      casual_expressions: false
    },
    casual: {
      formal_language: false,
      casual_expressions: true
    }
  };
  
  return indicators[style] || indicators.neutral;
}

function generateVersionId(contentType, topic) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  return \`\${contentType}-\${topicSlug}-\${timestamp}\`;
}

// 执行内容创作流水线
const result = await intelligentContentCreationPipeline(inputs);
output = result;
`,
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          content_type: { type: 'string', enum: ['article', 'blog', 'report', 'story'] },
          style: { type: 'string', enum: ['neutral', 'formal', 'casual'] },
          target_length: { type: 'number', minimum: 100, maximum: 5000 },
          context: { type: 'object' },
          use_memory: { type: 'boolean' }
        },
        required: ['topic'],
      },
      allowed_tools: ['memory_enhancer'],
      timeout: 300,
    },
    {
      name: 'memory_intelligent_search_workflow',
      description: '智能记忆搜索工作流：模糊搜索 → 语义匹配 → 结果排序 → 相关性分析',
      language: 'python',
      composition_code: `
# 智能记忆搜索工作流
import json
import re
from collections import defaultdict

def intelligent_search_workflow(query, search_options):
    """智能记忆搜索工作流"""
    
    # 步骤1: 模糊搜索
    fuzzy_results = await call_tool('memory_enhancer', {
        'action': 'intelligent_search',
        'language': 'python',
        'search_query': query,
        'search_options': {
            'fuzzy': True,
            'similarity_threshold': 0.6,
            'case_sensitive': False
        }
    })
    
    # 步骤2: 语义搜索
    semantic_results = await call_tool('memory_enhancer', {
        'action': 'intelligent_search',
        'language': 'python',
        'search_query': query,
        'search_options': {
            'semantic': True,
            'case_sensitive': False
        }
    })
    
    # 步骤3: 正则表达式搜索
    regex_results = await call_tool('memory_enhancer', {
        'action': 'intelligent_search',
        'language': 'python',
        'search_query': query,
        'search_options': {
            'regex': True,
            'case_sensitive': False
        }
    })
    
    # 步骤4: 结果合并和排序
    all_results = []
    for result_set in [fuzzy_results, semantic_results, regex_results]:
        if result_set.get('results'):
            all_results.extend(result_set['results'])
    
    # 去重和排序
    unique_results = []
    seen_paths = set()
    for result in all_results:
        if result.get('path') not in seen_paths:
            unique_results.append(result)
            seen_paths.add(result['path'])
    
    # 按相关性排序
    sorted_results = sorted(unique_results, key=lambda x: x.get('score', 0), reverse=True)
    
    # 步骤5: 相关性分析
    analysis = {
        'query': query,
        'total_results': len(sorted_results),
        'search_methods_used': ['fuzzy', 'semantic', 'regex'],
        'top_categories': defaultdict(int),
        'avg_score': sum(r.get('score', 0) for r in sorted_results) / len(sorted_results) if sorted_results else 0
    }
    
    # 分析结果分类
    for result in sorted_results[:10]:
        resultPath = result.get('path', '')
        if 'preference' in resultPath:
            analysis['top_categories']['preference'] += 1
        elif 'character' in resultPath:
            analysis['top_categories']['character'] += 1
        elif 'knowledge' in resultPath:
            analysis['top_categories']['knowledge'] += 1
    
    return {
        'status': 'success',
        'query': query,
        'results': sorted_results[:20],  # 返回前20个结果
        'analysis': analysis,
        'search_time_ms': 150
    }

# 执行工作流
result = intelligent_search_workflow(inputs['query'], inputs.get('search_options', {}))
output = result
`,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          search_options: { type: 'object' },
        },
        required: ['query'],
      },
      allowed_tools: ['memory_enhancer'],
      timeout: 120,
    },
    {
      name: 'memory_batch_organization',
      description: '批量记忆组织：扫描 → 分类 → 重命名 → 生成索引',
      language: 'javascript',
      composition_code: `
// 批量记忆组织工作流
async function batchOrganization(memoryFiles) {
  const results = {
    scanned: 0,
    categorized: 0,
    renamed: 0,
    indexed: 0,
    errors: []
  };
  
  // 步骤1: 扫描记忆文件
  for (const file of memoryFiles) {
    try {
      const content = await call_tool('read', { path: file });
      results.scanned++;
      
      // 步骤2: 智能分类
      const classification = await call_tool('memory_enhancer', {
        'action': 'smart_classify',
        'language': 'javascript',
        'operation_code': '// 分类逻辑由工具内部处理',
        'inputs': {
          'content': content.content,
          'context': { 'file_path': file }
        }
      });
      
      if (!classification.success) {
        results.errors.push(\`分类失败 \${file}: \${classification.error || '未知错误'}\`);
        continue;
      }
      
      // 步骤3: 根据分类重命名
      const category = classification.main_category;
      const fileName = file.split('/').pop();
      const newPath = \`memory/\${category}/\${fileName}\`;
      
      try {
        await call_tool('write', {
          'path': newPath,
          'content': content.content,
          'create_dirs': true
        });
        results.renamed++;
        
        // 步骤4: 生成索引条目
        const indexEntry = {
          path: newPath,
          category: category,
          tags: classification.tags,
          keywords: classification.keyword_count,
          content_length: classification.content_length,
          created_at: new Date().toISOString()
        };
        
        await call_tool('write', {
          'path': 'memory/index.json',
          'content': JSON.stringify([indexEntry], null, 2),
          'mode': 'append'
        });
        
        results.indexed++;
      } catch (renameError) {
        results.errors.push(\`重命名失败 \${file}: \${renameError.message}\`);
      }
    } catch (error) {
      results.errors.push(\`处理失败 \${file}: \${error.message}\`);
    }
  }
  
  // 步骤5: 生成组织报告
  const report = {
    operation: 'batch_organization',
    timestamp: new Date().toISOString(),
    summary: results,
    recommendations: []
  };
  
  // 生成建议
  if (results.errors.length > 0) {
    report.recommendations.push('检查文件权限和路径有效性');
  }
  
  if (results.categorized < results.scanned) {
    report.recommendations.push('改进分类算法以提高准确率');
  }
  
  await call_tool('write', {
    'path': 'memory/organization_report.json',
    'content': JSON.stringify(report, null, 2)
  });
  
  return {
    status: 'success',
    processed_files: memoryFiles.length,
    results: results,
    report_path: 'memory/organization_report.json'
  };
}

// 执行批量组织
const result = await batchOrganization(inputs['memory_files']);
output = result;
`,
      input_schema: {
        type: 'object',
        properties: {
          memory_files: { type: 'array', items: { type: 'string' } },
        },
        required: ['memory_files'],
      },
      allowed_tools: ['read', 'write', 'memory_enhancer'],
      timeout: 300,
    },
    {
      name: 'memory_data_mining',
      description: '记忆数据挖掘：模式识别 → 关联分析 → 知识提取 → 生成报告',
      language: 'python',
      composition_code: `
# 记忆数据挖掘工作流
import json
import re
from collections import defaultdict, Counter
from datetime import datetime

def memory_data_mining(memory_files):
    """记忆数据挖掘工作流"""
    
    mining_results = {
        patterns: {},
        associations: {},
        knowledge_extracted: [],
        statistics: {},
        insights: []
    }
    
    # 步骤1: 模式识别
    all_content = []
    content_by_file = {}
    
    for file_path in memory_files:
        try:
            content = await call_tool('read', { path: file_path })
            text_content = content.get('content', '')
            all_content.append(text_content)
            content_by_file[file_path] = text_content
        except:
            continue
    
    # 识别常见模式
    patterns = {
        'preference_patterns': [],
        'character_traits': [],
        'knowledge_domains': [],
        'event_sequences': []
    }
    
    # 使用增强工具进行模式识别
    for content in all_content:
        pattern_analysis = await call_tool('memory_enhancer', {
            'action': 'text_transformation',
            'language': 'python',
            'operation_code': '''
# 模式识别代码
import re

def extract_patterns(text):
    patterns = {
        'preferences': re.findall(r'偏好[:：]\\s*([^\\n]+)', text),
        'traits': re.findall(r'性格[:：]\\s*([^\\n]+)', text),
        'skills': re.findall(r'技能[:：]\\s*([^\\n]+)', text),
        'events': re.findall(r'事件[:：]\\s*([^\\n]+)', text)
    }
    return patterns
''',
            'inputs': { 'content': content }
        })
        
        if pattern_analysis.success:
            for pattern_type, matches in pattern_analysis.results.items():
                patterns[f'{pattern_type}_patterns'].extend(matches)
    
    mining_results['patterns'] = patterns
    
    # 步骤2: 关联分析
    associations = defaultdict(list)
    
    # 分析词语共现
    word_cooccurrence = defaultdict(lambda: defaultdict(int))
    
    for file_path, content in content_by_file.items():
        words = re.findall(r'\\b\\w+\\b', content.lower())
        for i, word1 in enumerate(words):
            for word2 in words[i+1:i+5]:  # 检查后面4个词
                word_cooccurrence[word1][word2] += 1
    
    # 找出强关联
    strong_associations = []
    for word1, related_words in word_cooccurrence.items():
        for word2, count in related_words.items():
            if count >= 3:  # 至少共现3次
                strong_associations.append({
                    'word1': word1,
                    'word2': word2,
                    'cooccurrence_count': count
                })
    
    mining_results['associations'] = {
        'strong_associations': sorted(strong_associations, 
                                   key=lambda x: x['cooccurrence_count'], 
                                   reverse=True)[:50],
        'total_pairs': len(strong_associations)
    }
    
    # 步骤3: 知识提取
    knowledge_extracted = []
    
    # 提取关键知识点
    for content in all_content:
        knowledge_extraction = await call_tool('memory_enhancer', {
            'action': 'memory_mining',
            'language': 'python',
            'operation_code': '''
# 知识提取代码
def extract_knowledge(text):
    knowledge_points = []
    
    # 提取偏好信息
    preferences = re.findall(r'(?:喜欢|偏好|爱好)[：:]*([^\\n。！？]+)', text)
    for pref in preferences:
        knowledge_points.append({
            'type': 'preference',
            'content': pref.strip(),
            'confidence': 0.8
        })
    
    # 提取技能信息
    skills = re.findall(r'(?:技能|能力|擅长)[：:]*([^\\n。！？]+)', text)
    for skill in skills:
        knowledge_points.append({
            'type': 'skill',
            'content': skill.strip(),
            'confidence': 0.9
        })
    
    return knowledge_points
''',
            'inputs': { 'content': content }
        })
        
        if knowledge_extraction.success:
            knowledge_extracted.extend(knowledge_extraction.results)
    
    mining_results['knowledge_extracted'] = knowledge_extracted
    
    # 步骤4: 统计分析
    mining_results['statistics'] = {
        'total_files_analyzed': len(memory_files),
        'total_content_length': sum(len(c) for c in all_content),
        'patterns_found': sum(len(v) for v in patterns.values()),
        'associations_found': len(strong_associations),
        'knowledge_points_extracted': len(knowledge_extracted),
        'analysis_timestamp': datetime.now().isoformat()
    }
    
    # 步骤5: 生成洞察
    insights = []
    
    if len(knowledge_extracted) > 10:
        insights.append("发现了丰富的知识结构，建议建立知识图谱")
    
    if len(strong_associations) > 100:
        insights.append("概念间关联紧密，适合进行语义搜索优化")
    
    top_preferences = [p for p in knowledge_extracted if p['type'] == 'preference']
    if len(top_preferences) > 5:
        insights.append("用户偏好信息充足，可以个性化推荐")
    
    mining_results['insights'] = insights
    
    return mining_results

# 执行数据挖掘
result = memory_data_mining(inputs['memory_files'])
output = result
`,
      input_schema: {
        type: 'object',
        properties: {
          memory_files: { type: 'array', items: { type: 'string' } },
        },
        required: ['memory_files'],
      },
      allowed_tools: ['read', 'memory_enhancer'],
      timeout: 180,
    },
    {
      name: 'memory_validation_and_cleanup',
      description: '记忆验证和清理：格式验证 → 数据清洗 → 完整性检查 → 生成报告',
      language: 'javascript',
      composition_code: `
// 记忆验证和清理工作流
async function memoryValidationAndCleanup(memoryFiles) {
  const validationResults = {
    validated: 0,
    cleaned: 0,
    errors: [],
    warnings: [],
    cleaned_files: []
  };
  
  for (const filePath of memoryFiles) {
    try {
      // 步骤1: 读取文件
      const fileContent = await call_tool('read', { path: filePath });
      let content = fileContent.content;
      const originalLength = content.length;
      
      // 步骤2: 数据验证
      const validation = await call_tool('memory_enhancer', {
        'action': 'data_validation',
        'language': 'javascript',
        'operation_code': '''
// 数据验证代码
function validateMemoryContent(content) {
  const issues = [];
  const warnings = [];
  
  // 检查空文件
  if (!content.trim()) {
    issues.push('文件内容为空');
  }
  
  // 检查编码问题
  if (content.includes('')) {
    issues.push('文件存在编码问题');
  }
  
  // 检查Markdown格式
  const lines = content.split('\\n');
  let hasHeaders = false;
  let hasLists = false;
  
  for (const line of lines) {
    if (line.startsWith('#')) hasHeaders = true;
    if (line.trim().match(/^[-*+]\\s/)) hasLists = true;
  }
  
  if (!hasHeaders && lines.length > 5) {
    warnings.push('建议添加标题结构');
  }
  
  // 检查重复行
  const lineCounts = {};
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed) {
      lineCounts[trimmed] = (lineCounts[trimmed] || 0) + 1;
    }
  });
  
  const duplicates = Object.entries(lineCounts)
    .filter(([_, count]) => count > 1)
    .map(([line, count]) => ({ line, count }));
  
  if (duplicates.length > 0) {
    warnings.push(\`发现 \${duplicates.length} 个重复行\`);
  }
  
  return {
    issues,
    warnings,
    duplicates,
    stats: {
      totalLines: lines.length,
      hasHeaders,
      hasLists
    }
  };
}
''',
        'inputs': { 'content': content }
      });
      
      if (!validation.success) {
        validationResults.errors.push(\`${filePath}: 验证失败\`);
        continue;
      }
      
      const validationData = validation.results;
      
      // 步骤3: 数据清洗
      let cleanedContent = content;
      let needsCleaning = false;
      
      // 清理多余空行
      cleanedContent = cleanedContent.replace(/\\n{3,}/g, '\\n\\n');
      
      // 清理行尾空格
      cleanedContent = cleanedContent.replace(/[ \\t]+$/gm, '');
      
      // 标准化换行符
      cleanedContent = cleanedContent.replace(/\\r\\n/g, '\\n');
      
      // 检查是否需要清理
      if (cleanedContent !== content) {
        needsCleaning = true;
        
        // 写入清理后的内容
        await call_tool('write', {
          path: filePath,
          'content': cleanedContent
        });
        
        validationResults.cleaned++;
        validationResults.cleaned_files.push({
          path: filePath,
          original_length: originalLength,
          cleaned_length: cleanedContent.length,
          reduction: originalLength - cleanedContent.length
        });
      }
      
      // 步骤4: 完整性检查
      const integrityCheck = {
        has_content: cleanedContent.trim().length > 0,
        has_structure: cleanedContent.includes('#') || cleanedContent.includes('##'),
        line_count: cleanedContent.split('\\n').length,
        word_count: cleanedContent.split(/\\s+/).filter(w => w).length
      };
      
      if (!integrityCheck.has_content) {
        validationResults.warnings.push(\`${filePath}: 文件内容为空\`);
      }
      
      validationResults.validated++;
      
    } catch (error) {
      validationResults.errors.push(\`${filePath}: 处理失败 - \${error.message}\`);
    }
  }
  
  // 步骤5: 生成清理报告
  const report = {
    operation: 'memory_validation_and_cleanup',
    timestamp: new Date().toISOString(),
    summary: validationResults,
    recommendations: []
  };
  
  // 生成建议
  if (validationResults.errors.length > 0) {
    report.recommendations.push('修复文件读取错误和权限问题');
  }
  
  if (validationResults.warnings.length > 0) {
    report.recommendations.push('完善文件结构和内容组织');
  }
  
  if (validationResults.cleaned > 0) {
    report.recommendations.push('定期进行数据清理以保持文件质量');
  }
  
  await call_tool('write', {
    'path': 'memory/validation_report.json',
    'content': JSON.stringify(report, null, 2)
  });
  
  return {
    status: 'success',
    processed_files: memoryFiles.length,
    validation_results: validationResults,
    report_path: 'memory/validation_report.json'
  };
}

// 执行验证和清理
const result = await memoryValidationAndCleanup(inputs['memory_files']);
output = result;
`,
      input_schema: {
        type: 'object',
        properties: {
          memory_files: { type: 'array', items: { type: 'string' } },
        },
        required: ['memory_files'],
      },
      allowed_tools: ['read', 'write', 'memory_enhancer'],
      timeout: 240,
    },
  ];
}
