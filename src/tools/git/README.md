# Git 工具

本模块仅查询 Git 仓库。仓库根目录必须位于调用方授权的工作区内，避免工作区子目录借由 Git 元数据访问上级仓库。

所有子命令固定、禁用 Git 可选锁、设置 15 秒超时和 512 KiB 输出上限；不提供任意命令透传或修改 Git 状态的操作。

| 工具 | 说明 |
| --- | --- |
| `git_status` | 当前分支与工作区状态。 |
| `git_diff` | 未暂存或暂存差异；`staged` 为 `true` 时查询暂存区。 |
| `git_log` | 最近提交摘要；`limit` 默认 20，最大 100。 |
| `git_branch_list` | 本地分支及其上游分支。 |

不提供 `add`、`commit`、`push`、`pull`、`reset`、`merge`、`rebase`、`stash` 或 Git 配置修改。
