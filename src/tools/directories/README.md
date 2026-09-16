# 目录工具

本模块操作已授权工作区内的目录。公共工作区授权由 `src/common/workspace.ts` 校验，回收目录和相对路径边界在本目录的 `workspace.ts` 内维护；目录操作不会跟随符号链接逃逸。

`directory_list` 始终注册。其余工具仅在当前项目配置的 `fileWritesEnabled` 为 `true` 时注册。

| 工具 | 说明 |
| --- | --- |
| `directory_list` | 列出目录的直接子项。 |
| `directory_create` | 递归创建目录；已存在时不修改。 |
| `directory_move` | 在同一工作区内移动或重命名目录；目标父目录必须存在。 |
| `directory_delete` | 移动到 `.chatgpt-mcp-trash` 回收目录，不递归销毁内容。 |

工作区根目录不能被移动或删除。
