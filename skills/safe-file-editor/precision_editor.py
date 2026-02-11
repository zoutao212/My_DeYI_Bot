# -*- coding: utf-8 -*-
"""
PrecisionEditor - 基于 diff-match-patch 的精确文件编辑器
提供字符级别的精确差异检测、模糊匹配补丁应用和三阶段验证机制。
"""

import hashlib
import logging
from dataclasses import dataclass
from typing import List, Tuple, Optional, Dict, Union
from diff_match_patch import diff_match_patch

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

@dataclass
class DiffResult:
    """Diff 操作结果"""
    success: bool
    message: str
    patches: List[str] = None
    original_fingerprint: str = ""
    new_fingerprint: str = ""
    changed_lines: List[int] = None

class PrecisionEditor:
    """
    使用 Google diff-match-patch 算法的精确编辑器
    提供比行号替换更安全、更灵活的代码修改方式
    """
    
    def __init__(self, file_content: str = "", file_path: str = None):
        """
        初始化编辑器
        
        Args:
            file_content: 文件内容字符串
            file_path: 文件路径（可选，用于日志）
        """
        self.dmp = diff_match_patch()
        # 配置 diff-match-patch 参数
        self.dmp.Diff_Timeout = 2.0  # Diff 计算超时时间 (秒)
        self.dmp.Match_Threshold = 0.5 # 匹配阈值 (0.0 - 1.0), 越小越严格
        self.dmp.Match_Distance = 1000 # 搜索距离
        self.dmp.Patch_DeleteThreshold = 0.5 # Patch 删除阈值
        self.dmp.Patch_Margin = 4 # Patch 上下文长度
        
        self.content = file_content
        self.file_path = file_path or "memory"
        
    def compute_fingerprint(self, text: str) -> str:
        """计算文本内容的 SHA256 指纹"""
        return hashlib.sha256(text.encode('utf-8')).hexdigest()
        
    def create_patch(self, target_content: str, replacement_content: str) -> List:
        """
        创建从 target_content 到 replacement_content 的补丁
        
        Args:
            target_content: 目标原始内容
            replacement_content: 替换后的新内容
            
        Returns:
            生成的 patch 对象列表
        """
        # 1. 生成 diff
        diffs = self.dmp.diff_main(target_content, replacement_content)
        self.dmp.diff_cleanupSemantic(diffs) # 语义清理，使 diff 更易读
        
        # 2. 生成 patch
        patches = self.dmp.patch_make(target_content, diffs)
        return patches

    def apply_patch_safely(self, patches: List) -> Tuple[str, List[bool]]:
        """
        安全应用补丁
        
        Args:
            patches: patch 对象列表
            
        Returns:
            (应用后的文本, 每个 patch 的应用成功状态列表)
        """
        new_text, results = self.dmp.patch_apply(patches, self.content)
        return new_text, results

    def verify_and_replace(self, 
                          target_block: str, 
                          replacement_block: str,
                          require_exact_match: bool = False) -> DiffResult:
        """
        三阶段验证替换流程：
        1. Pre-verification: 检查目标块是否存在（支持模糊匹配）
        2. Diff Generation: 生成精确 patch
        3. Post-verification: 应用 patch 并验证结果
        
        Args:
            target_block: 期望被替换的代码块
            replacement_block: 新的代码块
            require_exact_match: 是否要求目标块在文中精确匹配（非模糊）
            
        Returns:
            DiffResult 对象
        """
        # --- 阶段 1: 预验证 (Pre-verification) ---
        
        # 尝试在全文中定位目标块
        match_idx = self.dmp.match_main(self.content, target_block, 0)
        
        if match_idx == -1:
            return DiffResult(False, "❌ 无法在文件中找到目标代码块 (Fuzzy Match Failed)")
            
        if require_exact_match:
            # 验证精确匹配
            found_text = self.content[match_idx : match_idx + len(target_block)]
            if found_text != target_block:
                return DiffResult(False, "❌ 目标代码块不精确匹配 (Exact Match Failed)")

        logger.info(f"✅ [Pre-Check] 找到目标代码块，位置: {match_idx}")
        original_fingerprint = self.compute_fingerprint(self.content)

        # --- 阶段 2: 差异生成 (Diff Generation) ---
        
        # 我们不是对全文做 diff，而是只对目标块做 diff，然后将 patch 应用于全文
        # 这样可以确保只修改目标区域
        patches = self.create_patch(target_block, replacement_block)
        
        if not patches:
            return DiffResult(False, "⚠️ 生成的补丁为空 (内容可能未改变)")
            
        patch_text = self.dmp.patch_toText(patches)
        logger.info(f"✅ [Diff] 生成 {len(patches)} 个补丁块")

        # --- 阶段 3: 后验证 (Post-verification) ---
        
        # 尝试应用补丁
        new_content, apply_results = self.apply_patch_safely(patches)
        
        # 验证所有 patch 是否都成功应用
        if not all(apply_results):
            failed_indices = [i for i, res in enumerate(apply_results) if not res]
            return DiffResult(False, f"❌ 补丁应用失败: Patches {failed_indices} failed to apply")
            
        # 验证内容指纹变化
        new_fingerprint = self.compute_fingerprint(new_content)
        if original_fingerprint == new_fingerprint and target_block != replacement_block:
             return DiffResult(False, "❌ 文件内容指纹未改变 (虽然补丁报告成功)")

        # 更新内部状态
        self.content = new_content
        
        return DiffResult(
            success=True,
            message="✅ 精确替换成功",
            patches=[patch_text],
            original_fingerprint=original_fingerprint,
            new_fingerprint=new_fingerprint
        )

    def get_content(self) -> str:
        return self.content

    def get_block_info(self, block: str, context_lines: int = 3) -> Tuple[int, int, str, str]:
        """
        获取代码块的位置信息和上下文
        
        Args:
            block: 代码块内容
            context_lines: 上下文行数
            
        Returns:
            (start_index, start_line_number, context_prefix, context_suffix)
        """
        # 1. 查找位置
        match_idx = self.dmp.match_main(self.content, block, 0)
        if match_idx == -1:
            return -1, -1, "", ""
            
        # 2. 计算行号 (1-based)
        # 统计 match_idx 之前的换行符数量
        start_line = self.content.count('\n', 0, match_idx) + 1
        
        # 3. 获取上下文
        # 向前找 context_lines 个换行符
        prefix_end = match_idx
        prefix_start = prefix_end
        lines_found = 0
        while prefix_start > 0 and lines_found < context_lines:
            prefix_start = self.content.rfind('\n', 0, prefix_start - 1)
            if prefix_start != -1:
                lines_found += 1
            else:
                prefix_start = 0
                break
        
        # 如果找到换行符，prefix_start 指向 \n，需要 +1 才是下一行开始
        # 除非是文件开头
        if prefix_start > 0 or self.content.startswith('\n'):
             real_prefix_start = prefix_start + 1 if prefix_start > 0 else 0
        else:
             real_prefix_start = 0

        prefix = self.content[real_prefix_start:prefix_end]
        
        # 向后找 context_lines 个换行符
        suffix_start = match_idx + len(block)
        suffix_end = suffix_start
        lines_found = 0
        while suffix_end < len(self.content) and lines_found < context_lines:
            suffix_end = self.content.find('\n', suffix_end + 1)
            if suffix_end != -1:
                lines_found += 1
            else:
                suffix_end = len(self.content)
                break
                
        suffix = self.content[suffix_start:suffix_end]
        
        return match_idx, start_line, prefix, suffix
