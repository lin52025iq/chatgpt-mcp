# chatgpt-mcp

面向远程 ChatGPT 的本地 Streamable HTTP MCP 服务。它默认只监听回环地址，再通过 Cloudflare Tunnel 公开 HTTPS 入口。

## 能力

- 受授权工作区约束的本地文本文件、图片和音频读取，以及文本或二进制文件创建、目录与只读 Git 能力。
- 可聚合本机 stdio MCP 的只读工具。
- 可按配置启用项目内插件；OfficeCLI 提供 Office 文档查看、查询、批量编辑、模板创建、数据导入、媒体提取与截图。
- Cloudflare Tunnel 公开的 Streamable HTTP MCP 端点，以及 JSONL 运行日志。

## 初始化与启动

```powershell
pnpm install
Copy-Item .env.example .env
Copy-Item config.example.json config.json
# 编辑 .env：填写 CLOUDFLARE_MCP_URL、TUNNEL_TOKEN
# 编辑 config.json：按需填写 workspaceGrants 等项目配置
pnpm setup # 安装项目内 cloudflared 和 config.json 中已启用的插件
pnpm build
pnpm start
```

把 `CLOUDFLARE_MCP_URL` 配置到 ChatGPT 的 MCP 连接器即可。服务直接使用该 URL 的路径作为 MCP 端点；不再需要单独配置 `MCP_PATH`。

需要另一套配置时，复制示例并在启动时选择文件：

```powershell
Copy-Item config.example.json config.dev.json
# 编辑 config.dev.json
pnpm plugins:install -- --config config.dev.json # 仅安装已启用的插件
pnpm start -- --config config.dev.json
```

默认读取项目根目录的 `config.json`；可以用 `--config <文件路径>` 选择另一套配置。项目根目录的 `config*.json` 默认被 Git 忽略，`config.example.json` 保留在仓库中。`workspaceGrants` 是必填的授权目录数组；写入 `[]` 时仅授权项目根目录下的 `workspace`，非空数组则只授权列出的目录及其子目录，因此服务始终至少有一个可访问工作区。`fileWritesEnabled` 控制文件、目录及 Office 文档的写工具，外部 stdio MCP 定义直接写在 `mcpServers` 对象中。`pnpm runtime:install` 会把固定版本、经过 SHA-256 校验的官方 `cloudflared` 安装到 `.local-tools`；`pnpm start` 只调用该项目内二进制，不再依赖系统 `PATH`。`plugins.officecli.enabled` 为 `true` 时，运行 `pnpm plugins:install -- --config <同一配置文件>`，安装器只处理该配置中启用的插件。安装后重启服务；未安装时 `mcp_status` 和 Office 工具会给出安装命令。Runtime 和插件不会在服务启动或远程工具调用时自动下载。本地 HTTP 服务的端口由 `.env` 中的 `PORT` 设置（默认 `8787`）；非回环监听需设置 `allowNonLoopback: true`，额外的 HTTP 主机名可写入 `allowedHosts` 数组。

配置文件的 `$schema` 可以指向项目内的 [config.schema.json](schema/config.schema.json)。支持 JSON Schema 的编辑器会据此显示字段说明、补全和类型错误提示；运行时仍由 `src/config.ts` 校验配置。配置文件放在项目根目录以外时，需按该文件的位置调整 `$schema` 相对路径。

## 模块说明

- [本地工具模块](src/tools/README.md)：能力、输入边界和安全约束。
- [外部 MCP 接入](src/mcps/README.md)：`mcpServers` 配置、转发规则和日志边界。
- [项目内 OfficeCLI 插件](src/plugins/officecli/README.md)：配置驱动安装、项目内二进制和工具范围。
