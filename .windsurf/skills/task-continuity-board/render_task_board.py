# -*- coding: utf-8 -*-
"""render_task_board

把 TASK_BOARD.json 渲染成更适合“面板常驻展示”的 TASK_BOARD.md。

设计目标：
- 零第三方依赖（仅标准库）
- 输出稳定、可读性强
- 面向“任务中断后快速恢复”的阅读路径：先看当前聚焦与 next_action

用法（在本目录运行）：
- python render_task_board.py
- python render_task_board.py --json TASK_BOARD.json --md TASK_BOARD.md

返回码：
- 0 成功
- 1 失败（文件不存在/JSON 非法/结构不完整）
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _safe_get(d: Dict[str, Any], key: str, default: Any = "") -> Any:
    if not isinstance(d, dict):
        return default
    return d.get(key, default)


def _normalize_status(status: str) -> str:
    s = (status or "").strip().lower()
    if s in ("pending", "active", "completed", "blocked"):
        return s
    return "pending"


def _progress_bar(progress: str, width: int = 20) -> str:
    """把 progress 渲染成更美观的进度条。

    规则：
    - 支持形如 "30%"、" 30 %"、"30"（视为 30%）
    - 不可解析则返回原文，不做条形图
    """

    if not progress:
        return ""

    raw = str(progress).strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return ""

    try:
        value = int(digits)
    except ValueError:
        return ""

    value = max(0, min(100, value))
    filled = int(round(width * (value / 100.0)))
    
    # 更美观的进度条样式
    if value >= 80:
        bar = "🟩" * (filled // 4) + "🟨" * ((width - filled) // 4)
    elif value >= 50:
        bar = "🟩" * (filled // 4) + "🟨" * ((width - filled) // 4)
    else:
        bar = "🟥" * (filled // 4) + "🟨" * ((width - filled) // 4)
    return f"{bar} {value}%"


def _status_emoji(status: str) -> str:
    emoji_map = {
        "active": "🔄",
        "pending": "⏳", 
        "completed": "✅",
        "blocked": "🚫"
    }
    return emoji_map.get(status, "📋")


def _as_list(v: Any) -> List[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def _render_list(title: str, items: List[str]) -> str:
    if not items:
        return ""
    lines = [f"### {title}", ""]
    for it in items:
        if it is None:
            continue
        s = str(it).strip()
        if not s:
            continue
        lines.append(f"- {s}")
    lines.append("")
    return "\n".join(lines)


def _render_subtasks(subtasks: List[Dict[str, Any]]) -> Tuple[str, Dict[str, List[Dict[str, Any]]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {
        "active": [],
        "blocked": [],
        "pending": [],
        "completed": [],
    }

    for t in subtasks:
        if not isinstance(t, dict):
            continue
        status = _normalize_status(str(_safe_get(t, "status", "pending")))
        groups[status].append(t)

    def render_task_item(t: Dict[str, Any]) -> str:
        tid = str(_safe_get(t, "id", "")).strip()
        title = str(_safe_get(t, "title", "")).strip() or "（未命名子任务）"
        desc = str(_safe_get(t, "description", "")).strip()
        progress = str(_safe_get(t, "progress", "")).strip()
        deps = _as_list(_safe_get(t, "dependencies", []))
        outputs = _as_list(_safe_get(t, "outputs", []))
        notes = str(_safe_get(t, "notes", "")).strip()
        status = str(_safe_get(t, "status", "pending")).strip()
        emoji = _status_emoji(status)

        head = f"{emoji} **{tid}** {title}".strip()
        pb = _progress_bar(progress)
        lines = [f"- {head}"]
        
        # 详细的任务描述区块
        if desc:
            lines.append("  ```")
            lines.append(f"  📝 任务描述")
            lines.append(f"  {desc}")
            lines.append("  ```")
            
        # 进度详情区块
        if progress:
            lines.append("  ```")
            lines.append(f"  📈 当前进度")
            lines.append(f"  {progress}" + (f"  {pb}" if pb else ""))
            lines.append("  ```")
            
        # 依赖关系区块
        if deps:
            deps_s = ", ".join(str(x) for x in deps if str(x).strip())
            if deps_s:
                lines.append("  ```")
                lines.append("  🔗 前置依赖")
                lines.append(f"  {deps_s}")
                lines.append("  ```")
                
        # 产出物区块
        if outputs:
            outs = [str(x).strip() for x in outputs if str(x).strip()]
            if outs:
                lines.append("  ```")
                lines.append("  📦 交付物")
                for o in outs:
                    lines.append(f"  • {o}")
                lines.append("  ```")
                
        # 备注区块
        if notes:
            lines.append("  ```")
            lines.append("  💬 备注")
            lines.append(f"  {notes}")
            lines.append("  ```")
            
        return "\n".join(lines)

    lines: List[str] = []

    section_order = [
        ("active", "🔄 进行中"),
        ("blocked", "🚫 阻塞"),
        ("pending", "⏳ 待处理"),
        ("completed", "✅ 已完成"),
    ]

    for key, title in section_order:
        items = groups.get(key, [])
        lines.append(f"## {title}")
        lines.append("")
        if not items:
            lines.append("（空）")
            lines.append("")
            continue
        for t in items:
            lines.append(render_task_item(t))
        lines.append("")

    return "\n".join(lines), groups


def _render_status_summary(groups: Dict[str, List[Dict[str, Any]]]) -> str:
    active = len(groups.get("active", []))
    pending = len(groups.get("pending", []))
    blocked = len(groups.get("blocked", []))
    completed = len(groups.get("completed", []))
    total = active + pending + blocked + completed

    # 更美观的状态汇总表
    lines: List[str] = []
    lines.append("## 📊 状态汇总")
    lines.append("")
    lines.append("| 状态 | 数量 |")
    lines.append("| --- | ---: |")
    lines.append(f"| 🔄 进行中 | {active} |")
    lines.append(f"| 🚫 阻塞 | {blocked} |")
    lines.append(f"| ⏳ 待处理 | {pending} |")
    lines.append(f"| ✅ 已完成 | {completed} |")
    lines.append(f"| 📋 合计 | {total} |")
    lines.append("")
    return "\n".join(lines)


def render(json_path: Path, md_path: Path) -> None:
    if not json_path.exists():
        raise FileNotFoundError(f"未找到 JSON 文件：{json_path}")

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise ValueError(f"JSON 解析失败：{e}")

    board = data.get("TaskBoard") if isinstance(data, dict) else None
    if not isinstance(board, dict):
        raise ValueError("JSON 结构不完整：缺少 TaskBoard 对象")

    main = board.get("MainTask") if isinstance(board.get("MainTask"), dict) else {}
    subtasks = board.get("SubTasks") if isinstance(board.get("SubTasks"), list) else []
    focus = board.get("CurrentFocus") if isinstance(board.get("CurrentFocus"), dict) else {}
    checkpoints = board.get("Checkpoints") if isinstance(board.get("Checkpoints"), list) else []
    risks = board.get("RisksAndBlocks") if isinstance(board.get("RisksAndBlocks"), list) else []
    anchors = board.get("ContextAnchors") if isinstance(board.get("ContextAnchors"), dict) else {}

    title = str(_safe_get(main, "title", "")).strip() or "（未命名主任务）"
    objective = str(_safe_get(main, "objective", "")).strip()
    status = str(_safe_get(main, "status", "active")).strip()
    progress = str(_safe_get(main, "progress", "")).strip()

    focus_task_id = str(_safe_get(focus, "task_id", "")).strip()
    focus_reason = str(_safe_get(focus, "reasoning_summary", "")).strip()
    focus_next = str(_safe_get(focus, "next_action", "")).strip()

    version = str(_safe_get(board, "Version", "")).strip()
    last_updated = str(_safe_get(board, "LastUpdated", "")).strip() or _now_str()

    # anchors
    code_locs = [str(x).strip() for x in _as_list(_safe_get(anchors, "code_locations", [])) if str(x).strip()]
    commands = [str(x).strip() for x in _as_list(_safe_get(anchors, "commands", [])) if str(x).strip()]

    # checkpoints（只取最近一个用于面板摘要）
    last_cp = checkpoints[-1] if checkpoints and isinstance(checkpoints[-1], dict) else {}
    cp_summary = str(_safe_get(last_cp, "summary", "")).strip()
    cp_decisions = [str(x).strip() for x in _as_list(_safe_get(last_cp, "decisions", [])) if str(x).strip()]
    cp_open = [str(x).strip() for x in _as_list(_safe_get(last_cp, "open_questions", [])) if str(x).strip()]

    # risks
    risk_lines: List[str] = []
    for r in risks:
        if not isinstance(r, dict):
            continue
        desc = str(_safe_get(r, "description", "")).strip()
        mit = str(_safe_get(r, "mitigation", "")).strip()
        if not desc and not mit:
            continue
        if mit:
            risk_lines.append(f"{desc}（缓解：{mit}）" if desc else f"缓解：{mit}")
        else:
            risk_lines.append(desc)

    pb_main = _progress_bar(progress)

    # 子任务分组
    subtasks_rendered, groups = _render_subtasks(subtasks)

    # 顶部“最小填写提示”（让面板立刻变得可用）
    quick_fill_tips: List[str] = []
    if title == "（未命名主任务）":
        quick_fill_tips.append("MainTask.title")
    if not focus_next:
        quick_fill_tips.append("CurrentFocus.next_action")
    if subtasks and any(isinstance(t, dict) and not str(_safe_get(t, "title", "")).strip() for t in subtasks):
        quick_fill_tips.append("SubTasks[*].title")

    md_lines: List[str] = []
    md_lines.append("# 🎯 任务连续性看板")
    md_lines.append("")
    
    # 技能定位和目标说明
    md_lines.append("## 📋 技能定位")
    md_lines.append("")
    md_lines.append("这是一个让 Agent 在**对话意外中断/上下文窗口耗尽/重启**后，仍能**快速恢复任务状态并继续执行**的结构化任务进展看板能力。")
    md_lines.append("")
    md_lines.append("### 🎯 核心目标")
    md_lines.append("- **恢复成本最小化**：不依赖回忆整段对话，也不依赖链式推理复盘")
    md_lines.append("- **可执行恢复态**：只保留\"继续干活必须知道的内容\"（结论级、状态级、下一步行动）")
    md_lines.append("- **可持续维护**：在关键节点自动/半自动刷新看板，保证随时可重启")
    md_lines.append("")

    if quick_fill_tips:
        md_lines.append("> 💡 **快速提示**：补齐 " + "、".join(f"`{x}`" for x in quick_fill_tips) + "，面板会立刻变得更可读。")
        md_lines.append("")

    # 主任务区域
    md_lines.append("## 📋 主任务")
    md_lines.append("")
    md_lines.append(f"**{title}**")
    if objective:
        md_lines.append(f"🎯 目标：{objective}")
    md_lines.append(f"📊 状态：`{status}`")
    if progress:
        md_lines.append(f"📈 进度：{progress}" + (f"  {pb_main}" if pb_main else ""))
    md_lines.append(f"🕒 最后更新：{last_updated}")
    if version:
        md_lines.append(f"🏷️ 版本：{version}")
    md_lines.append("")

    md_lines.append("---")
    md_lines.append("")
    
    # 已完成功能概览
    completed_tasks = groups.get("completed", [])
    if completed_tasks:
        md_lines.append("## ✅ 已完成功能概览")
        md_lines.append("")
        for t in completed_tasks:
            tid = str(_safe_get(t, "id", "")).strip()
            title = str(_safe_get(t, "title", "")).strip()
            desc = str(_safe_get(t, "description", "")).strip()
            outputs = _as_list(_safe_get(t, "outputs", []))
            
            md_lines.append(f"### ✅ {tid} - {title}")
            if desc:
                md_lines.append(f"**功能描述**：{desc}")
            if outputs:
                outs = [str(x).strip() for x in outputs if str(x).strip()]
                if outs:
                    md_lines.append("**交付成果**：")
                    for o in outs:
                        md_lines.append(f"- {o}")
            md_lines.append("")
        md_lines.append("---")
        md_lines.append("")
    
    # 当前进展详情
    active_tasks = groups.get("active", [])
    if active_tasks:
        md_lines.append("## 🔄 当前进展详情")
        md_lines.append("")
        for t in active_tasks:
            tid = str(_safe_get(t, "id", "")).strip()
            title = str(_safe_get(t, "title", "")).strip()
            desc = str(_safe_get(t, "description", "")).strip()
            progress = str(_safe_get(t, "progress", "")).strip()
            deps = _as_list(_safe_get(t, "dependencies", []))
            notes = str(_safe_get(t, "notes", "")).strip()
            pb = _progress_bar(progress)
            
            md_lines.append(f"### 🔄 {tid} - {title}")
            if desc:
                md_lines.append(f"**当前工作**：{desc}")
            if progress:
                md_lines.append(f"**完成进度**：{progress}" + (f"  {pb}" if pb else ""))
            if deps:
                deps_s = ", ".join(str(x) for x in deps if str(x).strip())
                if deps_s:
                    md_lines.append(f"**前置条件**：{deps_s}")
            if notes:
                md_lines.append(f"**进展备注**：{notes}")
            md_lines.append("")
        md_lines.append("---")
        md_lines.append("")

    md_lines.append(_render_status_summary(groups).rstrip())
    md_lines.append("")
    md_lines.append("---")
    md_lines.append("")

    md_lines.append("## 当前聚焦（恢复优先看这里）")
    md_lines.append("")
    md_lines.append(f"- 当前子任务：`{focus_task_id or '（未设置）'}`")
    md_lines.append("")
    md_lines.append("> **下一步动作**")
    md_lines.append(">")
    md_lines.append(f"> {focus_next or '（未设置）'}")
    md_lines.append("")

    if focus_reason:
        md_lines.append("### 结论级摘要")
        md_lines.append("")
        # 允许多行
        md_lines.append("```text")
        md_lines.append(focus_reason)
        md_lines.append("```")
        md_lines.append("")

    md_lines.append("---")
    md_lines.append("")

    if cp_summary or cp_decisions or cp_open:
        md_lines.append("## 最近检查点")
        md_lines.append("")
        if cp_summary:
            md_lines.append(f"- 摘要：{cp_summary}")
        if cp_decisions:
            md_lines.append("- 已确认决策：")
            for x in cp_decisions:
                md_lines.append(f"  - {x}")
        if cp_open:
            md_lines.append("- 未决问题：")
            for x in cp_open:
                md_lines.append(f"  - {x}")
        md_lines.append("")
        md_lines.append("---")
        md_lines.append("")

    if risk_lines:
        md_lines.append("## 风险与阻塞")
        md_lines.append("")
        for x in risk_lines:
            md_lines.append(f"- {x}")
        md_lines.append("")
        md_lines.append("---")
        md_lines.append("")

    if code_locs or commands:
        md_lines.append("## 上下文锚点")
        md_lines.append("")
        if code_locs:
            md_lines.append("### 代码位置")
            md_lines.append("")
            for x in code_locs:
                md_lines.append(f"- {x}")
            md_lines.append("")
        if commands:
            md_lines.append("### 常用命令")
            md_lines.append("")
            for x in commands:
                md_lines.append(f"- {x}")
            md_lines.append("")
        md_lines.append("---")
        md_lines.append("")

    md_lines.append(subtasks_rendered.rstrip())
    md_lines.append("")

    md_lines.append("---")
    md_lines.append("")
    md_lines.append("## 恢复口令（新对话第一句话）")
    md_lines.append("")
    md_lines.append("```text")
    md_lines.append("按 CurrentFocus.next_action 继续，不要复盘旧对话。")
    md_lines.append("```")
    md_lines.append("")

    md_content = "\n".join(md_lines).rstrip() + "\n"
    md_path.write_text(md_content, encoding="utf-8")


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--json", default="TASK_BOARD.json", help="输入 JSON 文件路径")
    parser.add_argument("--md", default="TASK_BOARD.md", help="输出 Markdown 文件路径")
    args = parser.parse_args(argv)

    json_path = Path(args.json).resolve()
    md_path = Path(args.md).resolve()

    try:
        render(json_path=json_path, md_path=md_path)
    except Exception as e:
        print(f"❌ 渲染失败：{e}")
        return 1

    print(f"✅ 已生成面板：{md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
