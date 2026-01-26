# Clawdbot 私人定制 Git 工作流（Fork + Upstream + custom/main）

这份文档解释你当前仓库里 **`origin` / `upstream` / `custom/main`** 的含义，以及：

- 你要跟随官方更新时，应该从哪里拉取？
- 你要保存自己定制时，应该推送到哪里？
- 用 **TortoiseGit** 时远端/分支应该怎么选？
- 最少需要记住的“一键操作”是什么？

---

## 1. 关键概念（一定要记住的 3 个词）

### 1.1 `upstream`（官方仓库）

- **用途**：只用来获取官方更新。
- **指向**：`https://github.com/clawdbot/clawdbot.git`
- **你不应该向 upstream push**（除非你要给官方提 PR）。

### 1.2 `origin`（你的 fork 仓库）

- **用途**：保存你自己的修改、脚本、私人定制功能。
- **指向**：`https://github.com/<your-github-user>/clawdbot.git`
- **你应该 push 到 origin**。

### 1.3 `custom/main`（你的私人定制分支）

- **用途**：你所有私人定制都放在这个分支上。
- **你平时开发/提交/推送都在 `custom/main` 上进行**。

---

## 2. 你问的核心：拉官方更新 vs 拉自己更新

### 2.1 拉取官方更新：拉 `upstream/main`

- 官方的主分支是 **`main`**（不是 master）。
- 你想要“跟随官方升级”，就是把官方的更新合并到你的 `custom/main`。

一句话：

- **官方更新来源 = `upstream/main`**

### 2.2 拉取你自己的远端更新：拉 `origin/custom/main`

- 你自己的 fork 里存的是你自己的分支。
- 如果你在别的电脑也改了，然后想同步到这台机器：

一句话：

- **你自己的更新来源 = `origin/custom/main`**

---

## 3. 最推荐的日常流程（你只要记住这两条）

### 3.1 我想“跟随官方升级”

双击：

- `Git-Sync-Upstream.cmd`

它会自动执行：

- `git fetch upstream`
- 切换到 `custom/main`
- 自动 stash（包含未跟踪文件）
- `git merge upstream/main`
- `git push`（推到你的 fork：`origin/custom/main`）
- stash pop（把你本地未提交的改动恢复回来）

### 3.2 我想“保存我自己的修改”

双击：

- `Git-Commit-And-Push.cmd`

它会自动：

- `git add -A`
- 让你输入一个提交说明
- `git commit -m "..."`
- `git push` 到 `origin/custom/main`

---

## 4. TortoiseGit 怎么选（对应你截图里的下拉框）

### 4.1 拉官方更新（从 upstream 拉）

在 **Pull（拉取）** 里：

- **远端（Remote）**：选 `upstream`
- **远端分支（Remote Branch）**：选 `main`

如果下拉框里只看到 `master`：

- 先点右侧的刷新/浏览（`...`）按钮重新获取远端分支列表
- 或者用命令行确认：
  - `git branch -r`
  - 你应该能看到 `upstream/main`

> 结论：**官方更新永远从 `upstream/main` 来**。

### 4.2 拉你自己的更新（从 origin 拉）

在 **Pull（拉取）** 里：

- **远端（Remote）**：选 `origin`
- **远端分支（Remote Branch）**：选 `custom/main`

> 结论：你的私人分支更新从 `origin/custom/main` 来。

---

## 5. 常见问题（你遇到过的坑）

### 5.1 `custom/main` 不存在 / invalid reference

这通常发生在首次配置时。

- 解决：双击 `Git-Setup-Fork.cmd`

它会自动创建并切换到 `custom/main`。

### 5.2 merge 时提示本地改动会被覆盖

你本地有未提交修改时，`merge upstream/main` 可能会失败。

- 解决：用 `Git-Sync-Upstream.cmd`

它会自动 stash 后再 merge。

### 5.3 网页提示 `unauthorized: gateway token missing`

- 解决：双击 `Open-Clawdbot-UI.cmd`

它会读取 `~/.clawdbot/clawdbot.json` 并自动拼 token URL。

---

## 6. 你现在的目标（最佳实践）

- **开发/提交**：只在 `custom/main`
- **保存到 GitHub**：push 到 `origin/custom/main`
- **跟随官方升级**：合并 `upstream/main` 到 `custom/main`
