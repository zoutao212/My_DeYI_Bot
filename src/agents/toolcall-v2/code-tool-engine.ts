/**
 * OpenCAWD ToolCall 2.0 - Code Tool Engine
 * 
 * 实现 Code-as-Tool 范式的核心执行引擎
 */

import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';

/**
 * Code Tool 执行请求
 */
export interface CodeToolRequest {
  /** 编程语言 */
  language: 'python' | 'javascript' | 'typescript';
  /** 执行代码 */
  code: string;
  /** 输入变量 */
  inputs: Record<string, unknown>;
  /** 超时时间（秒） */
  timeout?: number;
  /** 允许的模块列表 */
  allowed_modules?: string[];
  /** 安全沙箱配置 */
  sandbox?: {
    /** 是否启用网络访问 */
    allowNetwork?: boolean;
    /** 允许的文件路径 */
    allowedPaths?: string[];
    /** 内存限制（MB） */
    memoryLimit?: number;
  };
}

/**
 * Code Tool 执行结果
 */
export interface CodeToolResult {
  /** 执行是否成功 */
  success: boolean;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 结构化输出（JSON 解析结果） */
  structured_output?: unknown;
  /** 执行时间（毫秒） */
  execution_time_ms: number;
  /** 错误信息 */
  error?: {
    type: 'timeout' | 'syntax_error' | 'runtime_error' | 'security_error';
    message: string;
    details?: unknown;
  };
}

/**
 * 代码静态分析结果
 */
export interface CodeAnalysis {
  /** 是否包含危险操作 */
  has_dangerous_ops: boolean;
  /** 危险操作列表 */
  dangerous_operations: string[];
  /** AST 解析错误 */
  syntax_error?: string;
  /** 依赖的模块 */
  imports: string[];
}

/**
 * Code Tool Engine
 */
export class CodeToolEngine {
  private readonly defaultTimeout = 30; // 30秒
  private readonly tempDir = join(tmpdir(), 'opencawd-code-tools');
  
  constructor() {
    // 确保临时目录存在
    mkdir(this.tempDir, { recursive: true }).catch(() => {});
  }

  /**
   * 执行代码工具
   */
  async execute(request: CodeToolRequest): Promise<CodeToolResult> {
    const startTime = Date.now();
    
    try {
      // 1. 静态分析
      const analysis = await this.analyzeCode(request);
      
      if (analysis.has_dangerous_ops) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          execution_time_ms: Date.now() - startTime,
          error: {
            type: 'security_error',
            message: `检测到危险操作: ${analysis.dangerous_operations.join(', ')}`,
            details: analysis.dangerous_operations,
          },
        };
      }

      if (analysis.syntax_error) {
        return {
          success: false,
          stdout: '',
          stderr: analysis.syntax_error,
          execution_time_ms: Date.now() - startTime,
          error: {
            type: 'syntax_error',
            message: '代码语法错误',
            details: analysis.syntax_error,
          },
        };
      }

      // 2. 准备执行环境
      const executionId = randomUUID();
      const workDir = join(this.tempDir, executionId);
      await mkdir(workDir, { recursive: true });

      // 3. 生成执行脚本
      const script = await this.generateScript(request, analysis);
      const scriptPath = join(workDir, this.getScriptFileName(request.language));
      await writeFile(scriptPath, script, 'utf-8');

      // 4. 生成输入文件
      const inputPath = join(workDir, 'inputs.json');
      await writeFile(inputPath, JSON.stringify(request.inputs), 'utf-8');

      // 5. 在沙箱中执行
      const result = await this.executeInSandbox(request, workDir, scriptPath, inputPath);

      // 6. 解析结构化输出
      if (result.success && result.stdout) {
        try {
          const lines = result.stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          
          // 尝试解析最后一行作为 JSON 输出
          if (lastLine.startsWith('{') || lastLine.startsWith('[')) {
            result.structured_output = JSON.parse(lastLine);
          }
        } catch {
          // 忽略 JSON 解析错误
        }
      }

      // 7. 清理临时文件
      await this.cleanup(workDir);

      return result;
    } catch (error) {
      return {
        success: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        execution_time_ms: Date.now() - startTime,
        error: {
          type: 'runtime_error',
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };
    }
  }

  /**
   * 静态分析代码
   */
  private async analyzeCode(request: CodeToolRequest): Promise<CodeAnalysis> {
    const analysis: CodeAnalysis = {
      has_dangerous_ops: false,
      dangerous_operations: [],
      imports: [],
    };

    // 检查危险操作
    const dangerousPatterns = [
      /eval\s*\(/,
      /exec\s*\(/,
      /__import__\s*\(/,
      /open\s*\(/,
      /subprocess\./,
      /os\.system/,
      /os\.popen/,
      /require\s*\(\s*['"]fs['"]/,
      /require\s*\(\s*['"]child_process['"]/,
      /import\s+.*\s+from\s+['"]fs['"]/,
      /import\s+.*\s+from\s+['"]child_process['"]/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(request.code)) {
        analysis.has_dangerous_ops = true;
        analysis.dangerous_operations.push(pattern.source);
      }
    }

    // 提取导入的模块
    const importPatterns = {
      python: /(?:import\s+(\w+)|from\s+(\w+))/g,
      javascript: /(?:import.*from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\))/g,
    };

    if (request.language === 'python') {
      let match;
      while ((match = importPatterns.python.exec(request.code)) !== null) {
        const module = match[1] || match[2];
        if (module && !analysis.imports.includes(module)) {
          analysis.imports.push(module);
        }
      }
    } else if (request.language === 'javascript' || request.language === 'typescript') {
      let match;
      while ((match = importPatterns.javascript.exec(request.code)) !== null) {
        const module = match[1] || match[2];
        if (module && !analysis.imports.includes(module)) {
          analysis.imports.push(module);
        }
      }
    }

    // 检查模块白名单
    if (request.allowed_modules && analysis.imports.length > 0) {
      const unauthorizedImports = analysis.imports.filter(
        imp => !request.allowed_modules!.includes(imp)
      );
      
      if (unauthorizedImports.length > 0) {
        analysis.has_dangerous_ops = true;
        analysis.dangerous_operations.push(
          ...unauthorizedImports.map(imp => `unauthorized_import:${imp}`)
        );
      }
    }

    return analysis;
  }

  /**
   * 生成执行脚本
   */
  private async generateScript(request: CodeToolRequest, analysis: CodeAnalysis): Promise<string> {
    const baseTemplate = await this.getTemplate(request.language);
    
    // 替换模板变量
    return baseTemplate
      .replace('{{CODE}}', request.code)
      .replace('{{INPUTS_FILE}}', 'inputs.json')
      .replace('{{ALLOWED_MODULES}}', JSON.stringify(request.allowed_modules || []));
  }

  /**
   * 获取语言模板
   */
  private async getTemplate(language: string): Promise<string> {
    const templates = {
      python: `#!/usr/bin/env python3
import json
import sys
import traceback

# 加载输入数据
try:
    with open('{{INPUTS_FILE}}', 'r', encoding='utf-8') as f:
        inputs = json.load(f)
except Exception as e:
    print(json.dumps({"error": f"Failed to load inputs: {e}"}))
    sys.exit(1)

# 注入输入变量到全局命名空间
globals().update(inputs)

# 用户代码
try:
{{CODE}}
    
    # 如果有 output 变量，输出它
    if 'output' in locals():
        print(json.dumps(output))
    
except Exception as e:
    error_info = {
        "error": str(e),
        "type": type(e).__name__,
        "traceback": traceback.format_exc()
    }
    print(json.dumps(error_info))
    sys.exit(1)
`,
      javascript: `const fs = require('fs');
const path = require('path');

// 加载输入数据
let inputs;
try {
    const inputsData = fs.readFileSync('{{INPUTS_FILE}}', 'utf-8');
    inputs = JSON.parse(inputsData);
} catch (e) {
    console.log(JSON.stringify({error: \`Failed to load inputs: \${e.message}\`}));
    process.exit(1);
}

// 用户代码
try {
{{CODE}}
    
    // 如果有 output 变量，输出它
    if (typeof output !== 'undefined') {
        console.log(JSON.stringify(output));
    }
    
} catch (e) {
    const errorInfo = {
        error: e.message,
        type: e.constructor.name,
        stack: e.stack
    };
    console.log(JSON.stringify(errorInfo));
    process.exit(1);
}
`,
    };

    return templates[language as keyof typeof templates] || templates.javascript;
  }

  /**
   * 获取脚本文件名
   */
  private getScriptFileName(language: string): string {
    const extensions = {
      python: 'script.py',
      javascript: 'script.js',
      typescript: 'script.ts',
    };

    return extensions[language as keyof typeof extensions] || 'script.js';
  }

  /**
   * 在沙箱中执行代码
   */
  private async executeInSandbox(
    request: CodeToolRequest,
    workDir: string,
    scriptPath: string,
    inputPath: string,
  ): Promise<CodeToolResult> {
    const timeout = request.timeout || this.defaultTimeout;
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      let child: ChildProcess;
      
      // 超时处理
      const timeoutHandle = setTimeout(() => {
        if (child && !child.killed) {
          child.kill('SIGKILL');
        }
        
        resolve({
          success: false,
          stdout: '',
          stderr: `执行超时 (${timeout}s)`,
          execution_time_ms: timeout * 1000,
          error: {
            type: 'timeout',
            message: `执行超时 (${timeout}s)`,
          },
        });
      }, timeout * 1000);

      try {
        // 根据语言选择执行器
        const command = this.getExecutorCommand(request.language, scriptPath, workDir);
        
        child = spawn(command.command, command.args, {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NODE_PATH: process.env.NODE_PATH,
            PYTHONPATH: process.env.PYTHON_PATH,
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          clearTimeout(timeoutHandle);
          
          const executionTime = Date.now() - startTime;
          const success = code === 0;

          resolve({
            success,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            execution_time_ms: executionTime,
            error: !success ? {
              type: 'runtime_error',
              message: `进程退出码: ${code}`,
              details: stderr,
            } : undefined,
          });
        });

        child.on('error', (error) => {
          clearTimeout(timeoutHandle);
          
          resolve({
            success: false,
            stdout: '',
            stderr: error.message,
            execution_time_ms: Date.now() - startTime,
            error: {
              type: 'runtime_error',
              message: error.message,
              details: error,
            },
          });
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        
        resolve({
          success: false,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          execution_time_ms: Date.now() - startTime,
          error: {
            type: 'runtime_error',
            message: error instanceof Error ? error.message : String(error),
            details: error,
          },
        });
      }
    });
  }

  /**
   * 获取执行器命令
   */
  private getExecutorCommand(language: string, scriptPath: string, workDir: string): {
    command: string;
    args: string[];
  } {
    switch (language) {
      case 'python':
        return {
          command: 'python3',
          args: [scriptPath],
        };
      case 'javascript':
        return {
          command: 'node',
          args: [scriptPath],
        };
      case 'typescript':
        return {
          command: 'npx',
          args: ['ts-node', scriptPath],
        };
      default:
        return {
          command: 'node',
          args: [scriptPath],
        };
    }
  }

  /**
   * 清理临时文件
   */
  private async cleanup(workDir: string): Promise<void> {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  }
}
