# 外部 MCP 接入

本目录将本机 stdio MCP 聚合为当前服务的工具。服务定义直接写在当前选定配置的 `mcpServers` 对象中，字段沿用 Cursor 的 stdio MCP 配置格式。

## 启用

编辑配置文件后重启服务；省略 `mcpServers` 或写为 `{}` 时不接入外部 MCP。最小示例：

```json
{
  "workspaceGrants": [],
  "fileWritesEnabled": false,
  "mcpServers": {
    "work-mcp": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\work-mcp\\dist\\index.js"],
      "toolAllowlist": ["lark_search_documents"]
    }
  }
}
```

## 配置字段

| 字段 | 说明 |
| --- | --- |
| `mcpServers` | 以服务名称为键的 MCP Server 对象。名称仅可使用小写字母、数字和连字符。 |
| `command` | 启动 stdio MCP 的本机命令。 |
| `args` | 传给 `command` 的字符串参数数组。 |
| `env` | 可选的字符串环境变量键值对；仅传给对应子进程。 |
| `toolAllowlist` | 本服务扩展的可选白名单，用于进一步缩小可转发工具。 |
| `workspacePathArguments` | 可选：要求这些工具入参为授权工作区内的绝对目录；适用于可跨项目查询的 MCP。 |

子 MCP 默认继承服务进程的环境变量。`command`、`args` 与 `env` 的字符串值支持 `${env:NAME}` 展开；路径列表可使用 `${env:NAME[0]}` 取第一个项目，并可用 `${env:NAME:-FALLBACK_NAME}` 指定回退环境变量。

配置了 `workspacePathArguments` 的服务，调用时必须为这些参数传入已授权的绝对目录；适用于支持跨工作区查询或按请求定位项目的 MCP。

## 转发边界

- 服务启动时连接每个配置的 stdio MCP 并枚举工具；单个服务失败不会阻塞其他模块。
- 仅转发上游标注 `readOnlyHint: true` 的工具；写工具不会暴露。
- 本地工具与外部工具重名时，本地工具优先，外部同名工具会跳过并记录日志。
- 不记录外部工具参数、返回内容或 `env` 值。连接与加载状态写入 `logs/`。

项目根目录的 `config*.json` 可能包含私有命令路径或环境变量，默认已在 `.gitignore` 中排除；`config.example.json` 除外。旧 `mcp.json` 不再被服务读取。
