# 文件工具

本模块只操作 `workspaceGrants` 授权的工作区；空数组默认仅授权项目根目录下的 `workspace`。所有路径会拒绝 `..`、NUL 字节和符号链接逃逸；`.chatgpt-mcp-trash` 是保留回收目录，工具不能直接操作它。目录操作见 [../directories/README.md](../directories/README.md)。

查询工具始终注册。创建、修改、删除工具仅在当前项目配置的 `fileWritesEnabled` 为 `true` 时注册。修改与删除须带 `file_read` 返回的最新 SHA-256。

| 操作 | 工具 |
| --- | --- |
| 工作区查询 | `workspace_list`：列出可访问工作区 |
| 创建 | `file_create`：在已有父目录创建 UTF-8 文件 |
| 二进制创建 | `file_create_binary`：将不超过 1 MiB 的 Base64 内容创建为新文件；`file_import`：接收 ChatGPT 文件参数并下载创建新文件 |
| 查询 | `file_list`：列出目录子项；`file_read`：读取 UTF-8 文件和 SHA-256；`media_read`：以 MCP 图片或音频内容返回本地媒体 |
| 修改 | `file_patch`：应用 Codex 风格上下文补丁；`file_write`：以完整内容更新；均需最新 SHA-256 |
| 删除 | `file_delete`：移动到回收目录，需最新 SHA-256 |

UTF-8 文本文件读写上限为 512 KiB；二进制工具使用下述独立限制。

`media_read` 根据文件头识别 PNG、JPEG、WebP、WAV 和 MP3，媒体大小上限为 4 MiB。它返回 MCP 媒体内容块与文件元数据；ChatGPT 是否把该内容块交给视觉或音频模型，需在实际连接器中验证。`file_read` 会拒绝无效 UTF-8 文件，避免把二进制内容误读为文本。

`file_create_binary` 只接受规范 Base64，不接受 data URL；1 MiB 上限使其请求保持在服务当前 2 MiB 的 MCP 请求体限制内。较大的 ChatGPT 文件使用 `file_import`，该工具按 [OpenAI 文件参数规范](https://developers.openai.com/plugins/reference)声明 `_meta["openai/fileParams"]`，要求 `file_id` 和临时 `download_url`。下载地址仅允许 OpenAI/ChatGPT 域名下的 HTTPS 地址，禁止重定向，超时为 30 秒，文件上限为 16 MiB。两个二进制写工具都受 `fileWritesEnabled` 控制，只创建新文件，不覆盖现有内容。若 ChatGPT 返回其他域名的签名下载地址，需先核实其来源再调整允许域名。

`file_patch` 的 `patch` 不包含文件路径，以一个或多个 `@@` 区块组成。每行以空格表示保留上下文、`-` 表示删除、`+` 表示新增；每个区块至少应保留一行原始上下文，以唯一定位修改位置。

```diff
@@ function greet() {
 export function greet() {
-  return "Hi";
+  return "Hello";
 }
```
