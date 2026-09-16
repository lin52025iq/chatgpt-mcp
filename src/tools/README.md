# 工具模块

本目录承载由本服务直接注册的 MCP Tool。所有模块都必须遵循授权工作区边界，并通过 `shared.ts` 统一返回 MCP 结果和记录工具调用日志。

| 模块 | 说明 |
| --- | --- |
| [files](files/README.md) | 工作区与文件操作。 |
| [directories](directories/README.md) | 授权工作区内的目录操作。 |
| [git](git/README.md) | 授权工作区内的只读 Git 仓库查询。 |

公共工作区授权由 `src/common/workspace.ts` 统一维护，各模块在自身目录内维护相对路径与数据安全边界。
