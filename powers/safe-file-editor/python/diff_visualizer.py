# -*- coding: utf-8 -*-
"""
DiffVisualizer - 差异可视化工具
提供终端彩色 Diff 输出、HTML 报告和 Side-by-Side 对比视图
"""

import html
from typing import List, Tuple
from diff_match_patch import diff_match_patch

class DiffVisualizer:
    """差异可视化生成器"""
    
    @staticmethod
    def _get_line_numbers(text: str) -> int:
        return len(text.splitlines())

    @staticmethod
    def generate_terminal_diff(old_text: str, new_text: str) -> str:
        """生成终端彩色 Diff (ANSI Color)"""
        dmp = diff_match_patch()
        diffs = dmp.diff_main(old_text, new_text)
        dmp.diff_cleanupSemantic(diffs)
        
        output = []
        for (op, data) in diffs:
            text = data
            if op == dmp.DIFF_INSERT:
                # 绿色
                output.append(f"\033[32m{text}\033[0m")
            elif op == dmp.DIFF_DELETE:
                # 红色
                output.append(f"\033[31m{text}\033[0m")
            elif op == dmp.DIFF_EQUAL:
                # 默认颜色
                output.append(text)
        
        return "".join(output)

    @staticmethod
    def generate_side_by_side_html(old_block: str, new_block: str, 
                                  start_line: int = 1,
                                  prefix: str = "", suffix: str = "") -> str:
        """
        生成带行号的 Side-by-Side HTML 预览
        
        Args:
            old_block: 原始代码块
            new_block: 新代码块
            start_line: 起始行号
            prefix: 前置上下文
            suffix: 后置上下文
        """
        dmp = diff_match_patch()
        
        # 1. 准备完整片段
        full_old = prefix + old_block + suffix
        full_new = prefix + new_block + suffix
        
        # 2. 分割成行
        old_lines = full_old.splitlines()
        new_lines = full_new.splitlines()
        
        # 3. 计算行数差异，补齐空行以保持对齐（简单对齐）
        # 注意：这里做的是简单对齐，如果差异很大，可能对不齐。
        # 理想情况是使用 difflib.SequenceMatcher 来对齐行，但为了保留字符级高亮，
        # 我们这里采用一种折中方案：
        # 将整个块进行 diff，然后尝试渲染回表格。
        
        # 重新生成 diff，这次是针对整个片段
        diffs = dmp.diff_main(full_old, full_new)
        dmp.diff_cleanupSemantic(diffs)
        
        # 将 diff 结果转换为行列表
        # 这是一个复杂的过程，我们需要同时跟踪左右两边的行号和内容
        
        rows = []
        current_old_line_idx = 0 # 相对索引
        current_new_line_idx = 0
        
        # 简化方案：直接使用 difflib.HtmlDiff 的逻辑太重，我们自己实现一个基于行的渲染
        # 但是为了保留 dmp 的高亮，我们还是得用 dmp。
        
        # 让我们尝试一种更直观的展示方式：
        # 左边显示 old_lines，右边显示 new_lines
        # 对于修改的部分，我们高亮显示。
        # 如果行数不同，我们不强求对齐，或者简单的并在最后补空行。
        
        max_lines = max(len(old_lines), len(new_lines))
        
        # 预计算每一行的 HTML (包含高亮)
        # 这比较难，因为 dmp 的 diff 是跨行的。
        
        # 替代方案：分别渲染左右两边，利用 diffs 信息
        # 左边：只渲染 DELETE 和 EQUAL
        # 右边：只渲染 INSERT 和 EQUAL
        
        def render_diff_to_html(diffs, is_left):
            html_parts = []
            for op, data in diffs:
                escaped = html.escape(data)
                if op == dmp.DIFF_EQUAL:
                    html_parts.append(escaped)
                elif op == dmp.DIFF_DELETE and is_left:
                    html_parts.append(f'<span class="del">{escaped}</span>')
                elif op == dmp.DIFF_INSERT and not is_left:
                    html_parts.append(f'<span class="ins">{escaped}</span>')
            return "".join(html_parts)

        left_html_full = render_diff_to_html(diffs, True)
        right_html_full = render_diff_to_html(diffs, False)
        
        left_lines_html = left_html_full.splitlines()
        right_lines_html = right_html_full.splitlines()
        
        # 修正：splitlines 会吃掉最后的空行如果 content 以 \n 结尾
        # 但这里用于显示，影响不大。
        
        # 4. 构建表格行
        table_rows = []
        
        # 计算上下文行数，用于标记
        prefix_lines_count = len(prefix.splitlines())
        
        for i in range(max_lines):
            # 左侧
            if i < len(left_lines_html):
                l_num = start_line + i - prefix_lines_count # 修正行号计算，使其从 prefix 开始前推
                # 其实 start_line 是 block 的开始。
                # 所以第一行 (prefix的第一行) 应该是 start_line - prefix_lines_count
                
                # 修正：传入的 start_line 是 block 的第一行
                # 所以 prefix 的第一行是 start_line - prefix_lines_count
                # 但是 prefix 可能为空
                
                real_l_num = (start_line - prefix_lines_count) + i
                l_content = left_lines_html[i]
            else:
                real_l_num = ""
                l_content = ""
                
            # 右侧
            if i < len(right_lines_html):
                r_num = (start_line - prefix_lines_count) + i
                r_content = right_lines_html[i]
            else:
                r_num = ""
                r_content = ""
            
            # 样式类
            row_class = ""
            if i < prefix_lines_count:
                row_class = "context"
            elif i >= max_lines - len(suffix.splitlines()):
                row_class = "context"
            else:
                row_class = "modified"
                
            table_rows.append(f"""
            <tr class="{row_class}">
                <td class="line-num">{real_l_num}</td>
                <td class="code">{l_content}</td>
                <td class="line-num">{r_num}</td>
                <td class="code">{r_content}</td>
            </tr>
            """)
            
        rows_html = "".join(table_rows)

        html_output = f"""
        <style>
            .diff-table {{ width: 100%; border-collapse: collapse; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; }}
            .diff-table td {{ padding: 2px 5px; vertical-align: top; }}
            .diff-table .line-num {{ 
                width: 40px; 
                text-align: right; 
                color: #999; 
                background-color: #f5f5f5; 
                border-right: 1px solid #ddd; 
                user-select: none;
            }}
            .diff-table .code {{ 
                width: 45%; 
                white-space: pre-wrap; 
                word-break: break-all;
                background-color: #fff;
            }}
            .del {{ background-color: #ffeef0; color: #b31d28; }}
            .ins {{ background-color: #e6ffed; color: #22863a; }}
            .context .code {{ color: #666; }}
            .modified .code {{ background-color: #fff; }}
            tr:hover td {{ background-color: #f8f9fa; }}
        </style>
        <table class="diff-table">
            {rows_html}
        </table>
        """
        
        return html_output

    @staticmethod
    def print_diff_summary(old_text: str, new_text: str):
        """打印 Diff 摘要到控制台"""
        print("\n🔍 --- Diff Preview ---")
        print(DiffVisualizer.generate_terminal_diff(old_text, new_text))
        print("----------------------\n")
