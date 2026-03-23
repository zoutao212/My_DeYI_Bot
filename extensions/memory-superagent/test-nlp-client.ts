/**
 * NLPClient 测试脚本
 *
 * 测试 NLP API 集成和降级功能
 */

import { NLPClient, EntityType, QueryType } from './nlp-client';
import { EnhancedQueryExpander } from './query-expander-enhanced';

// ============================================================================
// 测试配置
// ============================================================================

const NLP_API_URL = 'http://localhost:8080/v1/nlp';

// ============================================================================
// 测试用例
// ============================================================================

async function testHealthCheck() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 健康检查');
  console.log('='.repeat(60));

  const client = new NLPClient({ baseUrl: NLP_API_URL });

  try {
    const health = await client.healthCheck();
    console.log('服务状态:', health.healthy ? '✅ 健康' : '❌ 不健康');
    console.log('jieba 可用:', health.jiebaAvailable ? '✅ 是' : '❌ 否');
    return health.healthy;
  } catch (error) {
    console.error('❌ 健康检查失败:', error);
    return false;
  }
}

async function testSegment() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 中文分词');
  console.log('='.repeat(60));

  const client = new NLPClient({ baseUrl: NLP_API_URL, enableFallback: true });
  const text = '阿居最喜欢的女孩的名字是什么';

  try {
    const result = await client.segment(text, true);
    console.log(`原文: ${result.text}`);
    console.log('分词结果:');
    for (const seg of result.segments) {
      console.log(`  ${seg.text}/${seg.pos || '?'} [${seg.start_pos}-${seg.end_pos}]`);
    }
    return true;
  } catch (error) {
    console.error('❌ 分词失败:', error);
    return false;
  }
}

async function testExtractEntities() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 实体提取');
  console.log('='.repeat(60));

  const client = new NLPClient({ baseUrl: NLP_API_URL, enableFallback: true });
  const text = '阿居住在高雄，最喜欢《红楼梦》';

  try {
    const entities = await client.extractEntities(text);
    console.log(`原文: ${text}`);
    console.log(`实体数量: ${entities.length}`);
    for (const entity of entities) {
      console.log(`  [${entity.type}] ${entity.text} (置信度: ${entity.confidence}) [${entity.start_pos}-${entity.end_pos}]`);
    }
    return true;
  } catch (error) {
    console.error('❌ 实体提取失败:', error);
    return false;
  }
}

async function testExtractKeywords() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 关键词提取');
  console.log('='.repeat(60));

  const client = new NLPClient({ baseUrl: NLP_API_URL, enableFallback: true });
  const text = '阿居是一个热爱编程的大学生，他最喜欢使用 Python 和 TypeScript 进行开发';

  try {
    const keywords = await client.extractKeywords(text, 10);
    console.log(`原文: ${text}`);
    console.log(`关键词数量: ${keywords.length}`);
    for (const kw of keywords) {
      console.log(`  ${kw.text} (权重: ${kw.weight.toFixed(3)})`);
    }
    return true;
  } catch (error) {
    console.error('❌ 关键词提取失败:', error);
    return false;
  }
}

async function testAnalyze() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 完整查询分析');
  console.log('='.repeat(60));

  const client = new NLPClient({ baseUrl: NLP_API_URL, enableFallback: true });
  const query = '阿居最喜欢的女孩的名字是什么';

  try {
    const analysis = await client.analyze(query);
    console.log(`原始查询: ${analysis.original_query}`);
    console.log(`查询类型: ${analysis.query_type}`);
    console.log(`查询焦点: ${analysis.focus}`);

    console.log(`\n实体 (${analysis.entities.length} 个):`);
    for (const entity of analysis.entities) {
      console.log(`  [${entity.type}] ${entity.text} (置信度: ${entity.confidence})`);
    }

    console.log(`\n关键词 (${analysis.keywords.length} 个):`);
    for (const kw of analysis.keywords) {
      console.log(`  ${kw.text} (权重: ${kw.weight.toFixed(3)})`);
    }

    console.log(`\n分词结果 (${analysis.segments.length} 个):`);
    for (const seg of analysis.segments.slice(0, 10)) {
      console.log(`  ${seg.text}/${seg.pos || '?'}`);
    }

    console.log(`\n查询扩展 (${analysis.expansions.length} 个):`);
    for (const exp of analysis.expansions) {
      console.log(`  ${exp.text} (权重: ${exp.weight.toFixed(3)})`);
    }

    console.log(`\n搜索策略: ${analysis.strategy?.name || 'N/A'}`);
    console.log(`  描述: ${analysis.strategy?.description || 'N/A'}`);

    console.log(`\n元数据:`);
    console.log(`  处理时间: ${analysis.metadata.processing_time} ms`);
    console.log(`  数据来源: ${analysis.metadata.source}`);
    console.log(`  置信度: ${analysis.metadata.confidence}`);

    return true;
  } catch (error) {
    console.error('❌ 查询分析失败:', error);
    return false;
  }
}

async function testEnhancedExpander() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 增强版 QueryExpander');
  console.log('='.repeat(60));

  const expander = new EnhancedQueryExpander(5, 0.8, true, {
    enableNLPAPI: true,
    preferAPI: true,
    enableFallback: true,
    nlpClientConfig: {
      baseUrl: NLP_API_URL,
      timeout: 5000,
      enableCache: true,
    }
  });

  const query = '阿居最喜欢的女孩的名字是什么';

  try {
    // 检查 API 可用性
    const isAvailable = await expander.isAPIAvailable();
    console.log(`API 可用: ${isAvailable ? '✅ 是' : '❌ 否'}`);

    // 分析查询
    const analysis = await expander.analyze(query);
    console.log(`\n查询分析:`);
    console.log(`  类型: ${analysis.queryType}`);
    console.log(`  实体: ${analysis.entities.join(', ')}`);
    console.log(`  焦点: ${analysis.focus}`);

    // 获取搜索查询
    const queries = await expander.getSearchQueriesAsync(query);
    console.log(`\n搜索查询 (${queries.length} 个):`);
    for (const q of queries.slice(0, 10)) {
      console.log(`  ${q.text} (权重: ${q.weight.toFixed(2)}, 来源: ${q.source})`);
    }

    return true;
  } catch (error) {
    console.error('❌ EnhancedExpander 测试失败:', error);
    return false;
  }
}

async function testFallback() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 降级功能');
  console.log('='.repeat(60));

  // 使用无效 URL 触发降级
  const client = new NLPClient({
    baseUrl: 'http://invalid-url:9999/v1/nlp',
    enableFallback: true,
    timeout: 1000,
  });

  const query = '测试降级功能';

  try {
    const analysis = await client.analyze(query);
    console.log(`✅ 降级成功`);
    console.log(`数据来源: ${analysis.metadata.source}`);
    console.log(`置信度: ${analysis.metadata.confidence}`);
    return true;
  } catch (error) {
    console.error('❌ 降级失败:', error);
    return false;
  }
}

async function testCache() {
  console.log('\n' + '='.repeat(60));
  console.log('测试: 缓存功能');
  console.log('='.repeat(60));

  const client = new NLPClient({
    baseUrl: NLP_API_URL,
    enableCache: true,
    cacheTTL: 60,
  });

  const query = '测试缓存查询';

  try {
    // 第一次调用（应该调用 API）
    console.log('第一次调用...');
    const start1 = Date.now();
    const result1 = await client.analyze(query);
    const time1 = Date.now() - start1;
    console.log(`  处理时间: ${time1} ms`);

    // 第二次调用（应该从缓存获取）
    console.log('第二次调用（应该命中缓存）...');
    const start2 = Date.now();
    const result2 = await client.analyze(query);
    const time2 = Date.now() - start2;
    console.log(`  处理时间: ${time2} ms`);

    if (time2 < time1) {
      console.log(`✅ 缓存生效，速度提升 ${((time1 - time2) / time1 * 100).toFixed(1)}%`);
    } else {
      console.log('⚠️  缓存可能未生效');
    }

    return true;
  } catch (error) {
    console.error('❌ 缓存测试失败:', error);
    return false;
  }
}

// ============================================================================
// 主测试流程
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('     NLPClient 功能测试');
  console.log('='.repeat(60));
  console.log(`API 地址: ${NLP_API_URL}`);
  console.log(`请确保 Python NLP 服务已启动`);

  const tests = [
    { name: '健康检查', test: testHealthCheck },
    { name: '中文分词', test: testSegment },
    { name: '实体提取', test: testExtractEntities },
    { name: '关键词提取', test: testExtractKeywords },
    { name: '完整查询分析', test: testAnalyze },
    { name: '增强版 Expander', test: testEnhancedExpander },
    { name: '降级功能', test: testFallback },
    { name: '缓存功能', test: testCache },
  ];

  const results: { name: string; success: boolean }[] = [];

  for (const { name, test } of tests) {
    try {
      const success = await test();
      results.push({ name, success });
    } catch (error) {
      console.error(`❌ ${name} 测试异常:`, error);
      results.push({ name, success: false });
    }
  }

  // 汇总结果
  console.log('\n' + '='.repeat(60));
  console.log('     测试结果汇总');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.success).length;
  const total = results.length;

  for (const { name, success } of results) {
    const status = success ? '✅ 通过' : '❌ 失败';
    console.log(`${name}: ${status}`);
  }

  console.log(`\n总计: ${passed}/${total} 通过`);
  console.log('='.repeat(60));
}

// 运行测试
main().catch(console.error);
