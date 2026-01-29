# -*- coding: utf-8 -*-
"""
quick_replace.py - 快速安全替换工具

使用示例：
    # 按行号替换
    python quick_replace.py by-lines file.cpp 100 110 "new code here"
    
    # 按关键字替换
    python quick_replace.py by-keywords file.cpp "FString NetworkRoleStr" \\
        --context "PreMoveRotation,bMoveSuccess" \\
        --end "UE_RUNTIME_LOG" \\
        --code "new code here" \\
        --verify-vars "PreMoveRotation,PostMoveRotation"
"""

import sys
import argparse
from safe_file_editor import SafeFileEditor


def _read_code_arg(code: str, code_file: str) -> str:
    if code_file:
        with open(code_file, 'r', encoding='utf-8') as f:
            return f.read()
    return code or ""


def _write_output(text: str, out_file: str):
    if out_file:
        with open(out_file, 'w', encoding='utf-8') as f:
            f.write(text)
    else:
        sys.stdout.write(text)


def info_cmd(args):
    """输出文件基础信息（行数/行尾符/区间语义提示）"""
    editor = SafeFileEditor(args.file)
    total = len(editor.lines)
    sys.stdout.write(f"File: {editor.file_path}\n")
    sys.stdout.write(f"Lines: {total}\n")
    sys.stdout.write(f"LineEnding: {getattr(editor, 'line_ending_name', 'UNKNOWN')}\n")
    sys.stdout.write("RangeSemantics(default): 1-indexed, end inclusive\n")
    sys.stdout.write("Tip: pass --end-exclusive to treat end as exclusive; pass --clamp to auto clamp out-of-range\n")
    sys.exit(0)


def replace_by_lines(args):
    """按行号替换"""
    editor = SafeFileEditor(args.file)
    
    verify_vars = args.verify_vars.split(',') if args.verify_vars else None
    new_code = _read_code_arg(args.code, args.code_file)
    
    success = editor.replace_by_line_numbers(
        start_line=args.start,
        end_line=args.end,
        new_code=new_code,
        verify_vars=verify_vars,
        require_confirmation=not args.yes,
        end_inclusive=not args.end_exclusive,
        clamp=args.clamp
    )
    
    sys.exit(0 if success else 1)


def replace_by_keywords(args):
    """按关键字替换"""
    editor = SafeFileEditor(args.file)
    
    context_keywords = args.context.split(',') if args.context else None
    verify_vars = args.verify_vars.split(',') if args.verify_vars else None
    new_code = _read_code_arg(args.code, args.code_file)
    
    success = editor.replace_by_keywords(
        primary_keyword=args.primary,
        context_keywords=context_keywords,
        end_keyword=args.end,
        new_code=new_code,
        verify_vars=verify_vars,
        use_braces=args.braces,
        require_confirmation=not args.yes,
        pick_index=args.pick
    )
    
    sys.exit(0 if success else 1)


def extract_by_lines(args):
    """按行号提取代码块"""
    editor = SafeFileEditor(args.file)
    text = editor.extract_by_line_numbers(
        args.start,
        args.end,
        end_inclusive=not args.end_exclusive,
        clamp=args.clamp
    )
    _write_output(text, args.out)
    sys.exit(0)


def extract_by_anchor(args):
    """按锚点提取代码块"""
    editor = SafeFileEditor(args.file)
    text = editor.extract_by_anchor(args.before, args.after, include_anchors=args.include_anchors)
    _write_output(text, args.out)
    sys.exit(0)


def delete_range(args):
    """按行号删除区间（等价于 by-lines 替换为空）"""
    editor = SafeFileEditor(args.file)

    # 直接用 replace_by_line_numbers 的能力：new_code 为空即删除
    success = editor.replace_by_line_numbers(
        start_line=args.start,
        end_line=args.end,
        new_code='',
        verify_vars=None,
        require_confirmation=not args.yes,
        end_inclusive=not args.end_exclusive,
        clamp=args.clamp
    )
    sys.exit(0 if success else 1)


def delete_by_keywords(args):
    """按关键字删除代码块（绕开行号漂移）"""
    editor = SafeFileEditor(args.file)

    context_keywords = args.context.split(',') if args.context else None

    success = editor.delete_by_keywords(
        primary_keyword=args.primary,
        context_keywords=context_keywords,
        end_keyword=args.end,
        use_braces=args.braces,
        require_confirmation=not args.yes,
        pick_index=args.pick
    )

    sys.exit(0 if success else 1)


def delete_by_anchor(args):
    """按锚点删除代码块（绕开行号漂移）"""
    editor = SafeFileEditor(args.file)

    success = editor.delete_by_anchor(
        before_pattern=args.before,
        after_pattern=args.after,
        include_anchors=not args.exclude_anchors,
        require_confirmation=not args.yes
    )

    sys.exit(0 if success else 1)


def insert_by_anchor(args):
    """按锚点插入代码块（支持从文件读取大段代码）"""
    editor = SafeFileEditor(args.file)
    new_code = _read_code_arg(args.code, args.code_file)
    success = editor.insert_by_anchor(
        anchor_pattern=args.anchor,
        new_code=new_code,
        after=not args.before,
        offset=args.offset,
        require_confirmation=not args.yes
    )
    sys.exit(0 if success else 1)


def apply_ops(args):
    """应用可回放的操作列表（JSON）"""
    import json
    with open(args.ops_file, 'r', encoding='utf-8') as f:
        operations = json.load(f)
    editor = SafeFileEditor(args.file)
    success = editor.batch_replace(operations, dry_run=args.dry_run)
    sys.exit(0 if success else 1)


def main():
    parser = argparse.ArgumentParser(description='安全文件编辑工具（支持大文件）')
    subparsers = parser.add_subparsers(dest='command', help='Replacement method')

    info_parser = subparsers.add_parser('info', help='Print file info (lines/line-ending/range semantics)')
    info_parser.add_argument('file', help='Target file path')
    info_parser.set_defaults(func=info_cmd)
    
    # by-lines 子命令
    lines_parser = subparsers.add_parser('by-lines', help='Replace by line numbers')
    lines_parser.add_argument('file', help='Target file path')
    lines_parser.add_argument('start', type=int, help='Start line (1-indexed, inclusive)')
    lines_parser.add_argument('end', type=int, help='End line (1-indexed, inclusive)')
    lines_parser.add_argument('code', nargs='?', default='', help='新代码（可选，建议使用 --code-file）')
    lines_parser.add_argument('--code-file', help='从文件读取新代码（推荐，适合几百/几千行块）')
    lines_parser.add_argument('--verify-vars', help='Variables to verify (comma-separated)')
    lines_parser.add_argument('--clamp', action='store_true', help='当行号越界时自动夹取到合法范围')
    lines_parser.add_argument('--end-exclusive', action='store_true', help='将 end 视为排他式（end 不包含）')
    lines_parser.add_argument('-y', '--yes', '--non-interactive', action='store_true', help='Skip confirmation')
    lines_parser.set_defaults(func=replace_by_lines)
    
    # by-keywords 子命令
    keywords_parser = subparsers.add_parser('by-keywords', help='Replace by keywords')
    keywords_parser.add_argument('file', help='Target file path')
    keywords_parser.add_argument('primary', help='Primary keyword to search for')
    keywords_parser.add_argument('--context', help='Context keywords (comma-separated)')
    keywords_parser.add_argument('--end', help='End keyword or use --braces')
    keywords_parser.add_argument('--braces', action='store_true', help='Use brace matching')
    keywords_parser.add_argument('--pick', type=int, default=None, help='当匹配到多个候选时，选择第 N 个（0-based）')
    keywords_parser.add_argument('--code', default='', help='新代码（可选，建议使用 --code-file）')
    keywords_parser.add_argument('--code-file', help='从文件读取新代码（推荐，适合几百/几千行块）')
    keywords_parser.add_argument('--verify-vars', help='Variables to verify (comma-separated)')
    keywords_parser.add_argument('-y', '--yes', '--non-interactive', action='store_true', help='Skip confirmation')
    keywords_parser.set_defaults(func=replace_by_keywords)

    extract_lines_parser = subparsers.add_parser('extract-lines', help='Extract block by line numbers')
    extract_lines_parser.add_argument('file', help='Target file path')
    extract_lines_parser.add_argument('start', type=int, help='Start line (1-indexed, inclusive)')
    extract_lines_parser.add_argument('end', type=int, help='End line (1-indexed, inclusive)')
    extract_lines_parser.add_argument('--clamp', action='store_true', help='当行号越界时自动夹取到合法范围')
    extract_lines_parser.add_argument('--end-exclusive', action='store_true', help='将 end 视为排他式（end 不包含）')
    extract_lines_parser.add_argument('--out', help='输出到文件；不填则输出到标准输出')
    extract_lines_parser.set_defaults(func=extract_by_lines)

    extract_anchor_parser = subparsers.add_parser('extract-anchor', help='Extract block by anchors')
    extract_anchor_parser.add_argument('file', help='Target file path')
    extract_anchor_parser.add_argument('before', help='前置锚点（包含该行）')
    extract_anchor_parser.add_argument('after', help='后置锚点（包含该行）')
    extract_anchor_parser.add_argument('--include-anchors', action='store_true', help='提取时包含锚点行本身')
    extract_anchor_parser.add_argument('--out', help='输出到文件；不填则输出到标准输出')
    extract_anchor_parser.set_defaults(func=extract_by_anchor)

    delete_range_parser = subparsers.add_parser('delete-range', help='Delete range by line numbers')
    delete_range_parser.add_argument('file', help='Target file path')
    delete_range_parser.add_argument('start', type=int, help='Start line (1-indexed, inclusive)')
    delete_range_parser.add_argument('end', type=int, help='End line (1-indexed, inclusive)')
    delete_range_parser.add_argument('--clamp', action='store_true', help='当行号越界时自动夹取到合法范围')
    delete_range_parser.add_argument('--end-exclusive', action='store_true', help='将 end 视为排他式（end 不包含）')
    delete_range_parser.add_argument('-y', '--yes', '--non-interactive', action='store_true', help='Skip confirmation')
    delete_range_parser.set_defaults(func=delete_range)

    delete_keywords_parser = subparsers.add_parser('delete-keywords', help='Delete block by keywords')
    delete_keywords_parser.add_argument('file', help='Target file path')
    delete_keywords_parser.add_argument('primary', help='Primary keyword to search for')
    delete_keywords_parser.add_argument('--context', help='Context keywords (comma-separated)')
    delete_keywords_parser.add_argument('--end', help='End keyword or use --braces')
    delete_keywords_parser.add_argument('--braces', action='store_true', help='Use brace matching')
    delete_keywords_parser.add_argument('--pick', type=int, default=None, help='当匹配到多个候选时，选择第 N 个（0-based）')
    delete_keywords_parser.add_argument('-y', '--yes', '--non-interactive', action='store_true', help='Skip confirmation')
    delete_keywords_parser.set_defaults(func=delete_by_keywords)

    delete_anchor_parser = subparsers.add_parser('delete-anchor', help='Delete block by anchors')
    delete_anchor_parser.add_argument('file', help='Target file path')
    delete_anchor_parser.add_argument('before', help='前置锚点（匹配行）')
    delete_anchor_parser.add_argument('after', help='后置锚点（匹配行）')
    delete_anchor_parser.add_argument('--exclude-anchors', action='store_true', help='删除时不包含锚点行（默认包含）')
    delete_anchor_parser.add_argument('-y', '--yes', '--non-interactive', action='store_true', help='Skip confirmation')
    delete_anchor_parser.set_defaults(func=delete_by_anchor)

    insert_anchor_parser = subparsers.add_parser('insert-anchor', help='Insert block by anchor')
    insert_anchor_parser.add_argument('file', help='Target file path')
    insert_anchor_parser.add_argument('anchor', help='锚点（定位插入点）')
    insert_anchor_parser.add_argument('code', nargs='?', default='', help='要插入的新代码（可选，建议用 --code-file）')
    insert_anchor_parser.add_argument('--code-file', help='从文件读取要插入的代码（推荐）')
    insert_anchor_parser.add_argument('--before', action='store_true', help='在锚点之前插入（默认在之后）')
    insert_anchor_parser.add_argument('--offset', type=int, default=0, help='相对锚点偏移行数')
    insert_anchor_parser.add_argument('-y', '--yes', '--non-interactive', action='store_true', help='跳过确认')
    insert_anchor_parser.set_defaults(func=insert_by_anchor)

    ops_parser = subparsers.add_parser('apply-ops', help='Apply operations from JSON')
    ops_parser.add_argument('file', help='Target file path')
    ops_parser.add_argument('ops_file', help='JSON 文件：操作数组（可回放）')
    ops_parser.add_argument('--dry-run', action='store_true', help='只预览不落盘')
    ops_parser.set_defaults(func=apply_ops)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == '__main__':
    main()
