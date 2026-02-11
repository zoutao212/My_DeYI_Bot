# -*- coding: utf-8 -*-
"""
SafeFileEditor - 大型文件安全编辑工具
提供高级 API，内建验证、上下文检查、多重匹配处理等功能

使用方式：
    from safe_file_editor import SafeFileEditor
    
    editor = SafeFileEditor('path/to/file.cpp')
    editor.replace_by_line_numbers(100, 110, new_code)
    editor.replace_by_keywords(primary='FString', context=['Variable'], new_code=code)
"""

import io
import os
import sys
import re
import difflib
import shutil
import time
from typing import List, Optional, Tuple, Dict, Set
from dataclasses import dataclass
from precision_editor import PrecisionEditor
from diff_visualizer import DiffVisualizer


@dataclass
class EditContext:
    """编辑上下文信息"""
    file_path: str
    start_line: int  # 1-indexed
    end_line: int    # 1-indexed
    original_lines: List[str]
    new_code: str
    verification_passed: bool = False


class SafeFileEditor:
    """安全的文件编辑器，内建所有验证和上下文检查"""

    @staticmethod
    def _env_truthy(name: str) -> bool:
        v = (os.environ.get(name) or '').strip().lower()
        return v in ('1', 'true', 'yes', 'y', 'on')

    def _is_quiet(self) -> bool:
        # 运行在大文件/全量替换场景下，终端刷屏会导致“卡死”错觉。
        # 允许通过环境变量关闭上下文/预览输出。
        return self._env_truthy('SAFEFILEEDITOR_QUIET')
    
    @staticmethod
    def normalize_line(line: str) -> str:
        """规范化行内容（去除首尾空白，压缩中间空白）"""
        return ' '.join(line.strip().split())
    
    def __init__(self, file_path: str, encoding: str = 'utf-8'):
        """
        初始化编辑器
        
        Args:
            file_path: 文件路径
            encoding: 文件编码（Windows 通常是 utf-8）
        """
        self.file_path = os.path.abspath(file_path)
        self.encoding = encoding
        self.lines: List[str] = []
        self.line_ending = '\n'  # 默认为 LF
        self.line_ending_name = 'LF (Unix)'
        self._session_backup_path: Optional[str] = None
        self.load_file()
        self._detect_line_ending()
        
    def _detect_line_ending(self):
        """检测文件的行尾符类型"""
        try:
            with open(self.file_path, 'rb') as f:
                data = f.read(8192)  # 读取前8KB检测
            
            if b'\r\n' in data:
                self.line_ending = '\r\n'
                self.line_ending_name = 'CRLF (Windows)'
            else:
                self.line_ending = '\n'
                self.line_ending_name = 'LF (Unix)'
            
            print(f"📝 检测到行尾符: {self.line_ending_name}")
        except Exception as e:
            print(f"⚠️  行尾符检测失败，使用默认 LF: {e}")
    
    def _ensure_line_ending(self, text: str) -> str:
        """确保文本使用正确的行尾符
        
        Args:
            text: 输入文本
            
        Returns:
            统一行尾符后的文本
        """
        # 先统一为 \n
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        # 再替换为目标行尾符
        if self.line_ending == '\r\n':
            text = text.replace('\n', '\r\n')
        return text
    
    def _code_to_lines(self, code: str) -> List[str]:
        code = self._ensure_line_ending(code)
        if code == '':
            return []
        lines = code.splitlines(keepends=True)
        if lines and (not lines[-1].endswith('\n') and not lines[-1].endswith('\r\n')):
            lines[-1] += self.line_ending
        return lines
    
    def _ensure_session_backup(self):
        if self._session_backup_path is not None:
            return
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        self._session_backup_path = f"{self.file_path}.bak_{timestamp}"
        shutil.copy2(self.file_path, self._session_backup_path)
        print(f"💾 已创建备份: {self._session_backup_path}", flush=True)
    
    def load_file(self):
        """加载文件内容"""
        try:
            with io.open(self.file_path, 'r', encoding=self.encoding) as f:
                self.lines = f.readlines()
            print(f"✅ Loaded {len(self.lines)} lines from {self.file_path}", flush=True)
        except Exception as e:
            print(f"❌ Error loading file: {e}", flush=True)
            sys.exit(1)

    def _validate_line_range(self,
                             start_line: int,
                             end_line: int,
                             *,
                             op_name: str,
                             end_inclusive: bool = True,
                             clamp: bool = False) -> Tuple[int, int]:
        """校验并返回 0-based slice 索引（返回的是 Python slice 的 start_idx/end_idx）。

        约定（1-indexed 行号输入）：
        - start_line：包含
        - end_line：
          - end_inclusive=True  -> 包含式（历史默认）：slice_end = end_line
          - end_inclusive=False -> 排他式：slice_end = end_line - 1

        clamp=True 时：
        - 会把越界区间自动夹取到 [1, total] 的合法范围，并打印提示。
        - 仍会拒绝“夹取后为空”的区间（例如 start>=end）。
        """
        total = len(self.lines)

        if start_line <= 0 or end_line <= 0:
            raise ValueError(
                f"Invalid line range for {op_name}: {start_line}-{end_line}. "
                f"Line numbers must be >= 1. File has {total} lines."
            )

        original_start_line = start_line
        original_end_line = end_line

        if clamp:
            start_line = max(1, min(start_line, total + 1))
            end_line = max(1, min(end_line, total + 1))

        start_idx = start_line - 1
        end_idx = end_line if end_inclusive else (end_line - 1)

        if clamp:
            end_idx = max(0, min(end_idx, total))
            start_idx = max(0, min(start_idx, total))
            if original_start_line != start_line or original_end_line != end_line or end_idx != (original_end_line if end_inclusive else (original_end_line - 1)):
                mode_name = '包含式' if end_inclusive else '排他式'
                print(
                    f"⚠️  已自动夹取行号区间（{mode_name} end）："
                    f"{original_start_line}-{original_end_line} -> {start_line}-{end_line}"
                )

        if start_idx < 0 or start_idx > total:
            raise ValueError(
                f"Invalid line range for {op_name}: {original_start_line}-{original_end_line}. "
                f"File has {total} lines."
            )

        if end_idx < 0 or end_idx > total or start_idx >= end_idx:
            if end_inclusive:
                suggested_end = min(max(start_line, 1), total)
                suggested_range = f"{max(1, min(start_line, total))}-{suggested_end}"
                mode_tip = "提示：默认 end_line 为【包含式】；可用 --end-exclusive 切换为排他式。"
            else:
                suggested_end = min(max(start_line + 1, 2), total + 1)
                suggested_range = f"{max(1, min(start_line, total))}-{suggested_end}"
                mode_tip = "提示：当前 end_line 为【排他式】；不带 --end-exclusive 时默认为包含式。"

            raise ValueError(
                f"Invalid line range for {op_name}: {original_start_line}-{original_end_line}. "
                f"File has {total} lines. "
                f"{mode_tip} "
                f"可尝试使用合法区间，例如：{suggested_range}"
            )

        return start_idx, end_idx
    
    def save_file(self, new_lines: List[str]):
        """保存文件"""
        try:
            self._ensure_session_backup()
            tmp_path = f"{self.file_path}.tmp"
            with io.open(tmp_path, 'w', encoding=self.encoding) as f:
                f.writelines(new_lines)
            os.replace(tmp_path, self.file_path)
            print(f"✅ Saved {len(new_lines)} lines to {self.file_path}", flush=True)
        except Exception as e:
            print(f"❌ Error saving file: {e}", flush=True)
            sys.exit(1)
    
    def print_context(self, start_idx: int, end_idx: int, context_lines: int = 5):
        """
        打印扩展上下文
        
        Args:
            start_idx: 起始索引 (0-based)
            end_idx: 结束索引 (0-based, exclusive)
            context_lines: 前后显示的行数
        """
        if self._is_quiet():
            return

        total = len(self.lines)
        replace_count = max(0, end_idx - start_idx)
        context_start = max(0, start_idx - context_lines)
        context_end = min(total, end_idx + context_lines)

        # 避免“大范围替换”时把整文件上下文全部打印到终端，导致卡顿/假死。
        # 规则：当替换行数过大时，只打印头尾少量上下文 + 摘要。
        max_print_lines = 200
        
        print(f"\n{'='*70}", flush=True)
        print(f"Context: lines {context_start+1} to {context_end}", flush=True)
        print(f"Will replace: lines {start_idx+1} to {end_idx} (count={replace_count}, file_total={total})", flush=True)
        print(f"{'='*70}", flush=True)

        if (context_end - context_start) <= max_print_lines:
            for i in range(context_start, context_end):
                marker = ">>> " if start_idx <= i < end_idx else "    "
                line_num = f"{i+1:4d}"
                print(f"{marker}{line_num}: {self.lines[i].rstrip()}")
        else:
            head_n = 20
            tail_n = 20
            # 头部
            for i in range(context_start, min(context_start + head_n, context_end)):
                marker = ">>> " if start_idx <= i < end_idx else "    "
                line_num = f"{i+1:4d}"
                print(f"{marker}{line_num}: {self.lines[i].rstrip()}")
            print(f"    ... (省略 {max(0, (context_end - context_start) - head_n - tail_n)} 行上下文，避免终端卡顿) ...", flush=True)
            # 尾部
            for i in range(max(context_start, context_end - tail_n), context_end):
                marker = ">>> " if start_idx <= i < end_idx else "    "
                line_num = f"{i+1:4d}"
                print(f"{marker}{line_num}: {self.lines[i].rstrip()}")

        print(f"{'='*70}\n", flush=True)
    
    def check_variable_dependencies(self, 
                                   start_idx: int, 
                                   required_vars: List[str],
                                   search_range: int = 100) -> Tuple[bool, Set[str], Set[str]]:
        """
        检查变量依赖（支持正则匹配）
        
        Args:
            start_idx: 插入/替换位置 (0-based)
            required_vars: 需要的变量列表
            search_range: 向上搜索的行数
            
        Returns:
            (是否通过, 找到的变量, 缺失的变量)
        """
        found_vars = set()
        
        # 向上搜索变量定义
        search_start = max(0, start_idx - search_range)
        
        # 常见的变量定义/使用模式
        # 1. Type var = ...
        # 2. var = ...
        # 3. Type* var
        # 4. function(..., Type var, ...)
        # 5. class/struct { ... Type var; ... } (简单近似)
        
        for i in range(start_idx - 1, search_start - 1, -1):
            line = self.lines[i]
            # 移除注释
            code_part = line.split('//')[0].split('/*')[0]
            
            for var in required_vars:
                if var in found_vars:
                    continue
                    
                # 构建正则：匹配整词，且后面可能跟着 = , ; ) 等
                # 允许前面有 * & 等符号
                # \bvar\b 确保是整词
                pattern = r'\b' + re.escape(var) + r'\b'
                
                if re.search(pattern, code_part):
                    # 简单的启发式检查：是否像是一个定义或赋值
                    # 排除掉简单的函数调用 var()
                    if re.search(pattern + r'\s*[\=\(\{\;\,]', code_part) or \
                       re.search(r'[\*\&]\s*' + pattern, code_part) or \
                       re.search(r'\b[A-Z]\w+\s+[\*\&]*' + pattern, code_part): # Type var
                        found_vars.add(var)
                        print(f"  ✅ Found '{var}' at line {i+1}")
        
        missing_vars = set(required_vars) - found_vars
        
        if missing_vars:
            print(f"\n❌ ERROR: Variables {missing_vars} not found before line {start_idx+1}")
            print(f"Searched lines {search_start+1} to {start_idx}")
            return False, found_vars, missing_vars
        else:
            print(f"✅ All required variables found: {found_vars}")
            return True, found_vars, set()
    
    def find_by_keywords(self, 
                        primary_keyword: str,
                        context_keywords: Optional[List[str]] = None,
                        context_range: int = 50,
                        match_threshold: float = 0.9) -> List[int]:
        """
        通过关键字查找代码块（支持模糊匹配）
        
        Args:
            primary_keyword: 主关键字（必须出现在目标行）
            context_keywords: 上下文关键字（必须在附近出现）
            context_range: 上下文搜索范围（行数）
            match_threshold: 匹配阈值 (0.0 - 1.0)
            
        Returns:
            所有匹配位置的索引列表 (0-based)
        """
        candidates = []
        norm_primary = self.normalize_line(primary_keyword)
        
        for i, line in enumerate(self.lines):
            norm_line = self.normalize_line(line)
            
            # 1. 检查主关键字
            is_primary_match = False
            if primary_keyword in line: # 精确匹配
                is_primary_match = True
            elif match_threshold < 1.0: # 模糊匹配
                # 检查归一化后的包含关系
                if norm_primary in norm_line:
                    is_primary_match = True
                else:
                    # 使用 difflib 计算相似度
                    ratio = difflib.SequenceMatcher(None, norm_primary, norm_line).ratio()
                    # 如果行很长，ratio 可能很低，所以我们检查是否包含相似的子串
                    # 简化处理：如果 ratio 足够高，或者 norm_primary 是 norm_line 的一部分（容错）
                    if ratio >= match_threshold:
                        is_primary_match = True
            
            if is_primary_match:
                # 如果没有上下文约束，直接添加
                if not context_keywords:
                    candidates.append(i)
                    continue
                
                # 2. 检查上下文
                context_start = max(0, i - context_range)
                context_end = min(len(self.lines), i + context_range)
                
                # 获取上下文块并归一化
                context_block = [self.normalize_line(l) for l in self.lines[context_start:context_end]]
                context_text = ' '.join(context_block)
                
                found_count = 0
                missing = []
                
                for kw in context_keywords:
                    norm_kw = self.normalize_line(kw)
                    if norm_kw in context_text:
                        found_count += 1
                    elif match_threshold < 1.0:
                        # 模糊上下文匹配：检查是否有任何一行与关键字足够相似
                        # 这比较耗时，但更准确
                        if any(difflib.SequenceMatcher(None, norm_kw, l).ratio() >= match_threshold for l in context_block):
                            found_count += 1
                        else:
                            missing.append(kw)
                    else:
                        missing.append(kw)
                
                # 允许一定程度的上下文缺失（如果提供了很多上下文）
                # 这里我们要求所有上下文都匹配（或者模糊匹配成功）
                if not missing:
                    candidates.append(i)
                    print(f"✅ Valid candidate at line {i+1}")
                else:
                    print(f"❌ Rejected line {i+1}: missing context {missing}")
        
        return candidates
    
    def find_block_end(self, start_idx: int, end_keyword: Optional[str] = None, 
                      max_lines: int = 50, use_braces: bool = False) -> Optional[int]:
        """
        查找代码块结束位置
        
        Args:
            start_idx: 起始位置 (0-based)
            end_keyword: 结束关键字（可选）
            max_lines: 最大搜索行数
            use_braces: 是否使用大括号计数
            
        Returns:
            结束索引 (0-based, exclusive) 或 None
        """
        if use_braces:
            # 大括号计数法
            brace_count = 0
            for i in range(start_idx, min(start_idx + max_lines, len(self.lines))):
                brace_count += self.lines[i].count('{')
                brace_count -= self.lines[i].count('}')
                if brace_count == 0 and i > start_idx:
                    return i + 1
            return None
        elif end_keyword:
            # 关键字匹配法
            for i in range(start_idx, min(start_idx + max_lines, len(self.lines))):
                if end_keyword in self.lines[i]:
                    return i + 1
            return None
        else:
            print("❌ Must specify either end_keyword or use_braces=True")
            return None
    
    def replace_by_line_numbers(self, start_line: int, end_line: int, new_code: str,
                               verify_vars: Optional[List[str]] = None,
                               require_confirmation: bool = True,
                               end_inclusive: bool = True,
                               clamp: bool = False) -> bool:
        """
        通过行号替换代码（Phase 2.5）
        
        Args:
            start_line: 起始行号 (1-indexed, inclusive)
            end_line: 结束行号（默认 1-indexed, inclusive；当 end_inclusive=False 时视为排他式）
            new_code: 新代码（包含缩进和换行）
            verify_vars: 需要验证的变量（可选）
            require_confirmation: 是否需要用户确认
            end_inclusive: True=包含式 end（默认，与历史行为一致）；False=排他式 end
            clamp: True=当行号越界时自动夹取到合法范围；False=严格校验（默认）
            
        Returns:
            是否成功
        """
        try:
            start_idx, end_idx = self._validate_line_range(
                start_line,
                end_line,
                op_name='replace_by_line_numbers',
                end_inclusive=end_inclusive,
                clamp=clamp
            )
        except ValueError as e:
            print(f"❌ {e}")
            return False
        
        # 打印上下文（可通过 SAFEFILEEDITOR_QUIET=1 关闭，避免大范围替换时刷屏“卡死”）
        self.print_context(start_idx, end_idx)
        
        # 变量依赖检查
        if verify_vars:
            passed, found, missing = self.check_variable_dependencies(start_idx, verify_vars)
            if not passed:
                return False
        
        # 用户确认
        if require_confirmation:
            print(f"\n⚠️  Will replace {end_idx - start_idx} lines with new code")
            response = input("Continue? [y/N]: ")
            if response.lower() != 'y':
                print("❌ Aborted by user")
                return False
        
        # 执行替换
        replacement_lines = self._code_to_lines(new_code)
        new_lines = self.lines[:start_idx] + replacement_lines + self.lines[end_idx:]
        
        # 预览结果（静默模式下不输出）
        if not self._is_quiet():
            print("\n--- Preview of result ---", flush=True)
            preview_start = max(0, start_idx - 3)
            preview_end = min(len(new_lines), start_idx + 10)
            for i in range(preview_start, preview_end):
                print(f"  {i+1:4d}: {new_lines[i].rstrip()}", flush=True)

        # 保存
        self.save_file(new_lines)
        self.lines = new_lines  # 更新内部状态
        
        return True
    
    def replace_by_keywords(self, 
                          primary_keyword: str,
                          context_keywords: Optional[List[str]] = None,
                          end_keyword: Optional[str] = None,
                          new_code: str = '',
                          verify_vars: Optional[List[str]] = None,
                          use_braces: bool = False,
                          require_confirmation: bool = True,
                          pick_index: Optional[int] = None) -> bool:
        """
        通过关键字搜索并替换代码（Phase 3 + Phase 3.5）
        
        Args:
            primary_keyword: 主关键字
            context_keywords: 上下文关键字列表
            end_keyword: 结束关键字
            new_code: 新代码
            verify_vars: 需要验证的变量
            use_braces: 是否使用大括号匹配结束位置
            require_confirmation: 是否需要用户确认
            
        Returns:
            是否成功
        """
        # Step 1: 查找匹配
        candidates = self.find_by_keywords(primary_keyword, context_keywords)
        
        if len(candidates) == 0:
            print("❌ No matches found")
            return False
        elif len(candidates) > 1:
            if pick_index is not None:
                try:
                    pi = int(pick_index)
                except Exception:
                    pi = -1

                if 0 <= pi < len(candidates):
                    start_idx = candidates[pi]
                    print(f"⚠️  Found {len(candidates)} matches, use pick_index={pi} -> line {start_idx+1}")
                else:
                    print(f"⚠️  Found {len(candidates)} matches at lines: {[c+1 for c in candidates]}")
                    print(f"❌ Invalid pick_index={pick_index}, expected 0..{len(candidates)-1}")
                    return False
            else:
                print(f"⚠️  Found {len(candidates)} matches at lines: {[c+1 for c in candidates]}")
                print("Please add more context_keywords to narrow down the search")

                # 显示所有匹配
                for idx in candidates:
                    print(f"\n--- Match at line {idx+1} ---")
                    for i in range(max(0, idx-3), min(len(self.lines), idx+4)):
                        print(f"  {i+1:4d}: {self.lines[i].rstrip()}")
                print("\nTip: you can pass pick_index (0-based) to select one match when you are sure.")
                return False
        
        if len(candidates) == 1:
            start_idx = candidates[0]
            print(f"✅ Found unique match at line {start_idx+1}")
        
        # Step 2: 查找结束位置
        end_idx = self.find_block_end(start_idx, end_keyword, use_braces=use_braces)
        if end_idx is None:
            print("❌ Could not find end of block")
            return False
        
        print(f"✅ Block ends at line {end_idx}")
        
        # Step 3: 使用 replace_by_line_numbers 执行替换
        return self.replace_by_line_numbers(
            start_idx + 1, end_idx,
            new_code, verify_vars, require_confirmation
        )

    def check_function_exists(self, function_signature: str) -> Optional[int]:
        """
        检查函数是否已存在
        
        Args:
            function_signature: 函数签名（例如 "void AHCharacterBase::OnActorTransformChanged"）
            
        Returns:
            如果存在，返回函数定义的行号（0-based）；否则返回 None
        """
        # 归一化函数签名
        norm_signature = self.normalize_line(function_signature)
        
        for i, line in enumerate(self.lines):
            norm_line = self.normalize_line(line)
            
            # 检查是否包含函数签名
            if norm_signature in norm_line:
                print(f"✅ 找到已存在的函数 '{function_signature}' 在行 {i+1}")
                return i
        
        return None
    
    def append_function_safely(self, 
                              function_signature: str,
                              new_code: str,
                              force_append: bool = False) -> bool:
        """
        安全地追加函数（检查是否已存在）
        
        Args:
            function_signature: 函数签名（用于检查是否已存在）
            new_code: 新函数代码
            force_append: 是否强制追加（即使已存在）
            
        Returns:
            是否成功追加
        """
        # 检查函数是否已存在
        existing_line = self.check_function_exists(function_signature)
        
        if existing_line is not None:
            if force_append:
                print(f"⚠️ 警告：函数已存在于行 {existing_line+1}，但因 force_append=True 仍然追加")
            else:
                print(f"❌ 错误：函数已存在于行 {existing_line+1}，拒绝追加")
                print(f"提示：如果确定要追加，请设置 force_append=True")
                return False
        
        # 追加函数
        self.lines.extend(self._code_to_lines(new_code))
        
        # 保存
        self.save_file(self.lines)
        
        print(f"✅ 成功追加函数")
        return True
    
    # ========== 新功能：锚点定位 ==========
    
    def replace_by_anchor(self, before_pattern: str, after_pattern: str, 
                         new_code: str, include_anchors: bool = False,
                         require_confirmation: bool = True) -> bool:
        """使用前后锚点替换代码块
        
        Args:
            before_pattern: 前置锚点（标记开始位置）
            after_pattern: 后置锚点（标记结束位置）
            new_code: 新代码
            include_anchors: 是否替换包含锚点行本身
            require_confirmation: 是否需要用户确认
            
        Returns:
            是否成功
        """
        # 查找前置锚点
        before_idx = None
        for i, line in enumerate(self.lines):
            if before_pattern in line:
                before_idx = i
                break
        
        if before_idx is None:
            print(f"❌ 未找到前置锚点: {before_pattern}")
            return False
        
        # 查找后置锚点
        after_idx = None
        for i in range(before_idx + 1, len(self.lines)):
            if after_pattern in self.lines[i]:
                after_idx = i
                break
        
        if after_idx is None:
            print(f"❌ 未找到后置锚点: {after_pattern}")
            return False
        
        print(f"✅ 找到锚点范围: 行 {before_idx+1} 到 {after_idx+1}")
        
        # 确定替换范围
        if include_anchors:
            start_line = before_idx + 1
            end_line = after_idx + 1
        else:
            start_line = before_idx + 2
            end_line = after_idx
        
        # 使用已有方法执行替换
        new_code = self._ensure_line_ending(new_code)
        return self.replace_by_line_numbers(
            start_line, end_line, new_code, 
            verify_vars=None, require_confirmation=require_confirmation
        )
    
    def insert_by_anchor(self, anchor_pattern: str, new_code: str, 
                        after: bool = True, offset: int = 0,
                        require_confirmation: bool = True) -> bool:
        """在锚点位置插入代码
        
        Args:
            anchor_pattern: 锚点模式
            new_code: 要插入的代码
            after: True=在锚点后插入, False=在锚点前插入
            offset: 相对锚点的偏移行数
            require_confirmation: 是否需要用户确认
            
        Returns:
            是否成功
        """
        # 查找锚点
        anchor_idx = None
        for i, line in enumerate(self.lines):
            if anchor_pattern in line:
                anchor_idx = i
                break
        
        if anchor_idx is None:
            print(f"❌ 未找到锚点: {anchor_pattern}")
            return False
        
        print(f"✅ 找到锚点在行 {anchor_idx+1}")
        
        # 计算插入位置
        if after:
            insert_idx = anchor_idx + 1 + offset
        else:
            insert_idx = anchor_idx + offset
        
        # 确保插入位置有效
        insert_idx = max(0, min(insert_idx, len(self.lines)))
        
        # 打印上下文
        self.print_context(insert_idx, insert_idx, context_lines=3)
        
        # 用户确认
        if require_confirmation:
            print(f"\n⚠️  将在行 {insert_idx+1} 插入代码")
            response = input("继续? [y/N]: ")
            if response.lower() != 'y':
                print("❌ 用户取消")
                return False
        
        # 执行插入
        replacement_lines = self._code_to_lines(new_code)
        new_lines = self.lines[:insert_idx] + replacement_lines + self.lines[insert_idx:]
        
        # 保存
        self.save_file(new_lines)
        self.lines = new_lines
        
        print(f"✅ 成功插入代码")
        return True
    
    # ========== 新功能：批量操作 ==========
    
    def batch_replace(self, operations: List[Dict[str, any]], 
                     dry_run: bool = False,
                     diff_preview_max_lines: int = 400) -> bool:
        """批量执行多个编辑操作
        
        Args:
            operations: 操作列表，支持的操作类型:
                - {'type': 'replace_line', 'line': int, 'new_code': str}
                - {'type': 'replace_range', 'start': int, 'end': int, 'new_code': str}
                - {'type': 'insert_after', 'line': int, 'new_code': str}
                - {'type': 'insert_before', 'line': int, 'new_code': str}
                - {'type': 'delete_line', 'line': int}
                - {'type': 'append', 'new_code': str}
            dry_run: True时只显示预览，不实际执行
            diff_preview_max_lines: 预览的最大行数
            
        Returns:
            是否成功
        """
        print(f"\n📦 批量操作：{len(operations)} 个操作")
        
        # 按行号从大到小排序（避免行号偏移）
        def get_sort_key(op):
            if 'line' in op:
                return op['line']
            elif 'start' in op:
                return op['start']
            else:
                return float('inf')  # append 放最后
        
        sorted_ops = sorted(operations, key=get_sort_key, reverse=True)
        
        # 预览所有操作
        print("\n操作列表（倒序执行以避免行号偏移）：")
        for i, op in enumerate(sorted_ops, 1):
            op_type = op.get('type', 'unknown')
            if op_type == 'replace_line':
                print(f"  {i}. 替换第 {op['line']} 行")
            elif op_type == 'replace_range':
                print(f"  {i}. 替换第 {op['start']}-{op['end']} 行")
            elif op_type == 'insert_after':
                print(f"  {i}. 在第 {op['line']} 行后插入")
            elif op_type == 'insert_before':
                print(f"  {i}. 在第 {op['line']} 行前插入")
            elif op_type == 'delete_line':
                print(f"  {i}. 删除第 {op['line']} 行")
            elif op_type == 'append':
                print(f"  {i}. 追加到文件末尾")
        
        # 执行操作（先在内存中模拟，便于输出 Diff 预览）
        new_lines = self.lines.copy()
        
        try:
            for op in sorted_ops:
                op_type = op.get('type')
                
                if op_type == 'replace_line':
                    line_idx = op['line'] - 1
                    replacement_lines = self._code_to_lines(op.get('new_code', ''))
                    if not replacement_lines:
                        new_lines = new_lines[:line_idx] + new_lines[line_idx+1:]
                    else:
                        new_lines = new_lines[:line_idx] + replacement_lines + new_lines[line_idx+1:]
                    
                elif op_type == 'replace_range':
                    start_idx = op['start'] - 1
                    end_idx = op['end']
                    replacement_lines = self._code_to_lines(op.get('new_code', ''))
                    new_lines = new_lines[:start_idx] + replacement_lines + new_lines[end_idx:]
                    
                elif op_type == 'insert_after':
                    line_idx = op['line']
                    replacement_lines = self._code_to_lines(op.get('new_code', ''))
                    new_lines = new_lines[:line_idx] + replacement_lines + new_lines[line_idx:]
                    
                elif op_type == 'insert_before':
                    line_idx = op['line'] - 1
                    replacement_lines = self._code_to_lines(op.get('new_code', ''))
                    new_lines = new_lines[:line_idx] + replacement_lines + new_lines[line_idx:]
                    
                elif op_type == 'delete_line':
                    line_idx = op['line'] - 1
                    new_lines = new_lines[:line_idx] + new_lines[line_idx+1:]
                    
                elif op_type == 'append':
                    replacement_lines = self._code_to_lines(op.get('new_code', ''))
                    new_lines.extend(replacement_lines)
                    
                else:
                    print(f"⚠️  未知操作类型: {op_type}")
            
            # 预览 Diff
            original_text = "".join(self.lines)
            new_text = "".join(new_lines)
            diff_lines = list(difflib.unified_diff(
                original_text.splitlines(keepends=True),
                new_text.splitlines(keepends=True),
                fromfile=f"{self.file_path} (before)",
                tofile=f"{self.file_path} (after)",
                n=3
            ))

            print("\n🔍 变更预览 (Unified Diff):")
            if not diff_lines:
                print("（无差异）")
            else:
                if diff_preview_max_lines > 0 and len(diff_lines) > diff_preview_max_lines:
                    shown = diff_lines[:diff_preview_max_lines]
                    sys.stdout.write("".join(shown))
                    print(f"\n...（Diff 过长，已截断：显示 {diff_preview_max_lines}/{len(diff_lines)} 行）")
                else:
                    sys.stdout.write("".join(diff_lines))

            if dry_run:
                print("\n🔍 预览模式，不执行实际修改")
                return True

            # 保存
            self.save_file(new_lines)
            self.lines = new_lines
            print(f"✅ 批量操作成功完成")
            return True
            
        except Exception as e:
            print(f"❌ 批量操作失败: {e}")
            return False
    
    def extract_by_line_numbers(self,
                                start_line: int,
                                end_line: int,
                                end_inclusive: bool = True,
                                clamp: bool = False) -> str:
        start_idx, end_idx = self._validate_line_range(
            start_line,
            end_line,
            op_name='extract_by_line_numbers',
            end_inclusive=end_inclusive,
            clamp=clamp
        )
        return "".join(self.lines[start_idx:end_idx])

    def delete_by_anchor(self, before_pattern: str, after_pattern: str,
                         include_anchors: bool = True,
                         require_confirmation: bool = True) -> bool:
        """按锚点删除代码块（绕开行号漂移）。

        Args:
            before_pattern: 前置锚点（匹配行）
            after_pattern: 后置锚点（匹配行）
            include_anchors: 是否连锚点行一起删除（默认 True，更符合“删除整段”）
            require_confirmation: 是否需要用户确认

        Returns:
            是否成功
        """
        before_idx = None
        for i, line in enumerate(self.lines):
            if before_pattern in line:
                before_idx = i
                break
        if before_idx is None:
            print(f"❌ 未找到前置锚点: {before_pattern}")
            return False

        after_idx = None
        for i in range(before_idx + 1, len(self.lines)):
            if after_pattern in self.lines[i]:
                after_idx = i
                break
        if after_idx is None:
            print(f"❌ 未找到后置锚点: {after_pattern}")
            return False

        if include_anchors:
            start_line = before_idx + 1
            end_line = after_idx + 2
        else:
            start_line = before_idx + 2
            end_line = after_idx + 1

        return self.replace_by_line_numbers(
            start_line=start_line,
            end_line=end_line,
            new_code='',
            verify_vars=None,
            require_confirmation=require_confirmation
        )

    def delete_by_keywords(self,
                           primary_keyword: str,
                           context_keywords: Optional[List[str]] = None,
                           end_keyword: Optional[str] = None,
                           use_braces: bool = False,
                           require_confirmation: bool = True,
                           pick_index: Optional[int] = None) -> bool:
        """按关键字定位并删除代码块（绕开行号漂移）。

        规则与 replace_by_keywords 一致：
        - 先找 primary_keyword 的候选行
        - 再用 end_keyword 或 braces 计算块结束
        - 最后把该块替换为空（等价删除）
        """
        candidates = self.find_by_keywords(primary_keyword, context_keywords)

        if len(candidates) == 0:
            print("❌ No matches found")
            return False
        elif len(candidates) > 1:
            if pick_index is None:
                print(f"⚠️  Found {len(candidates)} matches at lines: {[c+1 for c in candidates]}")
                print("Please add more context_keywords to narrow down the search, or pass pick_index")
                return False

            try:
                pi = int(pick_index)
            except Exception:
                pi = -1

            if not (0 <= pi < len(candidates)):
                print(f"❌ Invalid pick_index={pick_index}, expected 0..{len(candidates)-1}")
                return False

            start_idx = candidates[pi]
            print(f"⚠️  Found {len(candidates)} matches, use pick_index={pi} -> line {start_idx+1}")
        else:
            start_idx = candidates[0]
            print(f"✅ Found unique match at line {start_idx+1}")

        end_idx = self.find_block_end(start_idx, end_keyword, use_braces=use_braces)
        if end_idx is None:
            print("❌ Could not find end of block")
            return False

        print(f"✅ Block ends at line {end_idx}")

        return self.replace_by_line_numbers(
            start_line=start_idx + 1,
            end_line=end_idx,
            new_code='',
            verify_vars=None,
            require_confirmation=require_confirmation
        )

    def extract_by_anchor(self, before_pattern: str, after_pattern: str, include_anchors: bool = False) -> str:
        before_idx = None
        for i, line in enumerate(self.lines):
            if before_pattern in line:
                before_idx = i
                break
        if before_idx is None:
            raise ValueError(f"未找到前置锚点: {before_pattern}")

        after_idx = None
        for i in range(before_idx + 1, len(self.lines)):
            if after_pattern in self.lines[i]:
                after_idx = i
                break
        if after_idx is None:
            raise ValueError(f"未找到后置锚点: {after_pattern}")

        if include_anchors:
            start_idx = before_idx
            end_idx = after_idx + 1
        else:
            start_idx = before_idx + 1
            end_idx = after_idx

        return "".join(self.lines[start_idx:end_idx])
    
    # ========== 新功能：精确编辑器 (v4.0) ==========
    
    def replace_precisely(self, target_block: str, replacement_block: str, 
                         require_exact_match: bool = False,
                         require_confirmation: bool = True) -> bool:
        """
        使用 diff-match-patch 算法进行精确替换 (v4.0)
        
        Args:
            target_block: 目标代码块（原始内容）
            replacement_block: 新代码块
            require_exact_match: 是否要求精确匹配（False则允许模糊匹配）
            require_confirmation: 是否需要用户确认
            
        Returns:
            是否成功
        """
        # 1. 准备内容
        current_content = "".join(self.lines)
        target_block = self._ensure_line_ending(target_block)
        replacement_block = self._ensure_line_ending(replacement_block)
        
        # 2. 初始化精确编辑器
        p_editor = PrecisionEditor(current_content, self.file_path)
        
        # 3. 执行三阶段验证和替换
        print("\n🔄 正在执行精确替换分析...")
        
        # 获取位置信息用于报告 (v4.4)
        match_idx, start_line, prefix, suffix = p_editor.get_block_info(target_block)
        
        result = p_editor.verify_and_replace(target_block, replacement_block, require_exact_match)
        
        if not result.success:
            print(result.message)
            return False
            
        # 4. 显示 Diff 预览
        print("\n🔍 变更预览 (Diff):")
        DiffVisualizer.print_diff_summary(target_block, replacement_block)
        
        # 5. 用户确认
        if require_confirmation:
            response = input("确认应用此精确补丁? [y/N]: ")
            if response.lower() != 'y':
                print("❌ 用户取消")
                return False
        
        # 6. 更新文件内容
        # PrecisionEditor 已经更新了内部 content，我们需要同步回 self.lines
        new_content = p_editor.get_content()
        
        # 保持行尾符一致性
        if self.line_ending == '\r\n':
            new_lines = new_content.splitlines(keepends=True)
        else:
            new_lines = new_content.splitlines(keepends=True)
            
        self.lines = new_lines
        self.save_file(self.lines)
        
        print(f"{result.message}")
        print(f"✅ 指纹变化: {result.original_fingerprint[:8]} -> {result.new_fingerprint[:8]}")
        
        # 7. 生成 HTML Diff 报告 (v4.1)
        try:
            import os
            import time
            
            # 创建 diffs 目录
            diff_dir = os.path.join(os.path.dirname(self.file_path), '.gemini', 'diffs')
            if not os.path.exists(diff_dir):
                os.makedirs(diff_dir, exist_ok=True)
                
            # 生成文件名
            filename = os.path.basename(self.file_path)
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            report_path = os.path.join(diff_dir, f"{filename}_{timestamp}.diff.html")
            
            # 生成 HTML 内容 (v4.4: 传入行号和上下文)
            html_content = DiffVisualizer.generate_side_by_side_html(
                target_block, replacement_block, 
                start_line=start_line,
                prefix=prefix, suffix=suffix
            )
            
            # 包装成完整的 HTML 页面
            full_html = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Diff: {filename}</title>
                <style>
                    body {{ font-family: sans-serif; padding: 20px; }}
                    h2 {{ color: #333; }}
                    .meta {{ color: #666; margin-bottom: 20px; }}
                </style>
            </head>
            <body>
                <h2>Diff Report: {filename}</h2>
                <div class="meta">Generated at {time.strftime("%Y-%m-%d %H:%M:%S")}</div>
                {html_content}
            </body>
            </html>
            """
            
            with open(report_path, 'w', encoding='utf-8') as f:
                f.write(full_html)
                
            # 输出可点击链接
            # 使用 file:/// 协议格式，确保在大多数终端和 IDE 中可点击
            report_url = f"file:///{report_path.replace(os.sep, '/')}"
            print(f"\n📊 Diff Report Generated: \n👉 \033[4;34m{report_url}\033[0m")
            
            # 尝试自动在浏览器中打开 (v4.2)
            try:
                import webbrowser
                webbrowser.open(report_url)
            except:
                pass

            # 8. 生成原生 Diff 支持 (v4.2)
            # 保存原始文件备份
            orig_path = os.path.join(diff_dir, f"{filename}_{timestamp}.orig")
            with open(orig_path, 'w', encoding='utf-8') as f:
                f.write(current_content)
                
            # 生成 .diff 文件 (Unified Diff，IDE 支持高亮)
            diff_path = os.path.join(diff_dir, f"{filename}_{timestamp}.diff")
            unified_diff = p_editor.dmp.patch_toText(p_editor.dmp.patch_make(current_content, new_content))
            with open(diff_path, 'w', encoding='utf-8') as f:
                f.write(unified_diff)
                
            diff_url = f"file:///{diff_path.replace(os.sep, '/')}"
            print(f"📄 Unified Diff File (IDE Highlighted): \n👉 \033[4;34m{diff_url}\033[0m")
            
            # 输出 code --diff 命令
            print(f"\n💡 Tip: Run this command to view native diff in VS Code:")
            print(f"\033[33mcode --diff \"{orig_path}\" \"{self.file_path}\"\033[0m")
            
        except Exception as e:
            print(f"⚠️ Failed to generate diff reports: {e}")
        
        return True

    # ========== 新功能：上下文管理器（自动备份恢复） ==========
    
    def __enter__(self):
        """进入上下文：创建备份"""
        import shutil
        self.backup_file = self.file_path + '.backup'
        shutil.copy2(self.file_path, self.backup_file)
        print(f"💾 已创建备份: {self.backup_file}")
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出上下文：失败时自动恢复"""
        import os
        import shutil
        
        if exc_type is not None:
            # 发生异常，恢复备份
            shutil.copy2(self.backup_file, self.file_path)
            print(f"❌ 操作失败，已从备份恢复: {exc_val}")
            os.remove(self.backup_file)
            return False  # 继续传播异常
        else:
            # 成功，删除备份
            if os.path.exists(self.backup_file):
                os.remove(self.backup_file)
                print(f"✅ 操作成功，已删除备份")
            return True
    
    # ========== 新功能：PowerShell 兼容性 ==========
    
    def generate_temp_script(self, operations: List[Dict]) -> str:
        """生成可执行的临时Python脚本文件
        
        Args:
            operations: 操作列表
            
        Returns:
            临时脚本文件路径
        """
        import tempfile
        import json
        import os
        
        # 创建临时脚本
        script_content = f'''# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, r'{os.path.dirname(__file__)}')
from safe_file_editor import SafeFileEditor

editor = SafeFileEditor(r'{self.file_path}')
operations = {json.dumps(operations, ensure_ascii=False, indent=2)}

success = editor.batch_replace(operations)
sys.exit(0 if success else 1)
'''
        
        # 写入临时文件
        fd, temp_path = tempfile.mkstemp(suffix='.py', prefix='safe_edit_')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(script_content)
        
        print(f"📝 已生成临时脚本: {temp_path}")
        return temp_path
    
    @classmethod
    def get_cli_command(cls, file_path: str, start_line: int, end_line: int, 
                       code_file: str) -> str:
        """生成可在命令行执行的安全命令
        
        Args:
            file_path: 目标文件路径
            start_line: 起始行号
            end_line: 结束行号
            code_file: 包含新代码的文件路径
            
        Returns:
            可执行的命令字符串
        """
        import os
        script_dir = os.path.dirname(__file__)
        
        # 生成 PowerShell 安全的命令
        command = f'''python -c "import sys; sys.path.insert(0, r'{script_dir}'); from safe_file_editor import SafeFileEditor; editor = SafeFileEditor(r'{file_path}'); new_code = open(r'{code_file}', 'r', encoding='utf-8').read(); editor.replace_by_line_numbers({start_line}, {end_line}, new_code, require_confirmation=False)"'''
        
        return command






def main():
    """命令行接口示例"""
    if len(sys.argv) < 2:
        print("Usage: python safe_file_editor.py <file_path>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    editor = SafeFileEditor(file_path)
    
    print(f"\n📝 Loaded {len(editor.lines)} lines")
    print("Available methods:")
    print("  - editor.replace_by_line_numbers(start, end, code)")
    print("  - editor.replace_by_keywords(primary, context, code)")
    
    # 进入交互模式
    import code
    code.interact(local=locals())


if __name__ == '__main__':
    main()
