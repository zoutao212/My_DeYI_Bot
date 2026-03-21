#!/usr/bin/env node

/**
 * ToolCall 2.0 简单测试脚本
 * 
 * 测试代码工具和工具组合器的基本功能
 */

import { createCodeTool } from './src/agents/toolcall-v2/code-tool.js';
import { createToolComposerTool } from './src/agents/toolcall-v2/tool-composer-tool.js';

async function testCodeTool() {
  console.log('🧪 测试 Code Tool...');
  
  const codeTool = createCodeTool();
  
  try {
    // 测试 Python 代码执行
    const pythonResult = await codeTool.execute('test-1', {
      language: 'python',
      code: `
# 简单的数据处理
data = inputs['numbers']
filtered = [x for x in data if x > inputs['threshold']]
output = {
  'original_count': len(data),
  'filtered_count': len(filtered),
  'filtered_numbers': filtered,
  'threshold': inputs['threshold']
}
`,
      inputs: {
        numbers: [1, 5, 10, 15, 20, 25, 30],
        threshold: 15
      },
      timeout: 10,
      allowed_modules: ['json']
    });
    
    console.log('✅ Python 代码执行成功');
    console.log('输出:', JSON.stringify(pythonResult.details, null, 2));
    
  } catch (error) {
    console.error('❌ Python 代码执行失败:', error.message);
  }
  
  try {
    // 测试 JavaScript 代码执行
    const jsResult = await codeTool.execute('test-2', {
      language: 'javascript',
      code: `
// 字符串处理
const text = inputs.text;
const words = text.split(' ').filter(word => word.length > 3);
output = {
  original_text: text,
  word_count: text.split(' ').length,
  long_words: words,
  long_words_count: words.length
};
`,
      inputs: {
        text: 'The quick brown fox jumps over the lazy dog'
      },
      timeout: 10
    });
    
    console.log('✅ JavaScript 代码执行成功');
    console.log('输出:', JSON.stringify(jsResult.details, null, 2));
    
  } catch (error) {
    console.error('❌ JavaScript 代码执行失败:', error.message);
  }
}

async function testToolComposer() {
  console.log('\n🧪 测试 Tool Composer...');
  
  const toolComposer = createToolComposerTool();
  
  try {
    // 测试列出可用组合
    const listResult = await toolComposer.execute('list-1', {
      action: 'list'
    });
    
    console.log('✅ 列出工具组合成功');
    console.log('可用组合:', listResult.details?.compositions?.length || 0);
    
  } catch (error) {
    console.error('❌ 列出工具组合失败:', error.message);
  }
  
  try {
    // 测试执行预定义组合
    const execResult = await toolComposer.execute('exec-1', {
      action: 'execute',
      composition_name: 'file_analysis_pipeline',
      inputs: {
        file_path: '/test/example.txt',
        analysis_type: 'summary',
        output_path: '/test/analysis_report.md'
      }
    });
    
    console.log('✅ 执行工具组合成功');
    console.log('执行状态:', execResult.details?.success ? '成功' : '失败');
    console.log('执行时间:', execResult.details?.execution_time_ms, 'ms');
    
  } catch (error) {
    console.error('❌ 执行工具组合失败:', error.message);
  }
  
  try {
    // 测试创建自定义组合
    const createResult = await toolComposer.execute('create-1', {
      action: 'create',
      language: 'javascript',
      composition_code: `
// 自定义数据处理流程
const data = inputs.data;
const processed = data.map(item => ({
  ...item,
  processed: true,
  timestamp: Date.now()
}));

// 调用另一个工具（模拟）
const writeResult = await call_tool('write', {
  path: inputs.output_path,
  content: JSON.stringify(processed, null, 2)
});

result = {
  processed_count: processed.length,
  output_path: inputs.output_path,
  write_result: writeResult
};
`,
      inputs: {
        data: [
          { id: 1, name: 'Alice', score: 85 },
          { id: 2, name: 'Bob', score: 92 },
          { id: 3, name: 'Charlie', score: 78 }
        ],
        output_path: '/tmp/processed_data.json'
      },
      allowed_tools: ['write'],
      timeout: 30
    });
    
    console.log('✅ 创建自定义组合成功');
    console.log('执行状态:', createResult.details?.success ? '成功' : '失败');
    console.log('工具调用次数:', createResult.details?.tool_calls?.length || 0);
    
  } catch (error) {
    console.error('❌ 创建自定义组合失败:', error.message);
  }
}

async function main() {
  console.log('🚀 开始测试 ToolCall 2.0...\n');
  
  await testCodeTool();
  await testToolComposer();
  
  console.log('\n✨ 测试完成！');
}

// 运行测试
main().catch(console.error);
