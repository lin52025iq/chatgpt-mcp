# OfficeCLI 项目内插件

在选定的 `config.json` 中设置 `"plugins": { "officecli": { "enabled": true } }`，再运行 `pnpm plugins:install -- --config config.json`。安装器从 [固定发行版清单](../../../plugins/officecli.json)选取当前系统与架构的官方文件，验证 SHA-256 后保存到 `.local-tools/officecli/<version>/`。该目录不提交到 Git；运行时只调用此处的二进制，不使用系统 `PATH`。未启用时不下载、检查或注册 Office 工具；禁用不会删除已经安装的文件。

读取工具包括 `office_skill`、`office_help`、`office_view`、`office_get`、`office_query`、`office_validate`、`office_raw` 和 `office_dump`。可查看文本、结构、问题、HTML/SVG、节点、OpenXML 部件和 OfficeCLI 实际支持的元素属性。`office_view` 返回文档 SHA-256；大文档宜用节点查询或较小的导出子树，避免超过单次 CLI 输出的 1 MiB 限制。

启用 `fileWritesEnabled` 后，除原有的 `office_screenshot`、`office_create`、`office_add_element`、`office_set_cell`、`office_replace_text` 外，还注册 `office_edit`、`office_merge`、`office_import_data`、`office_extract_media`、`office_raw_set`、`office_add_part` 和 `office_refresh`。`office_edit` 接受最多 30 个结构化的 `set`、`add`、`remove`、`move`、`swap` 操作；先用 `office_help` 核对元素类型和属性，再用 `office_get` 或 `office_query` 找到 DOM 路径。每个操作的普通属性放在 `props`，引用本地图片等素材的 `src`、`path`、`preview`、`image`、`nativePath`、`background` 放在 `file_properties`，值为工作区内的相对文件路径。工具会校验并转换为本机绝对路径；`background` 转成 OfficeCLI 所需的 `image:<路径>`。批次默认原子执行：一项失败则整个批次回滚。对已有文档的修改需要传入最新的 `expected_sha256`；同一服务进程内的 Office 写入按目标文件串行处理。

`office_merge` 从模板创建同类型新文档，数据可直接放在 `data`（不超过 8 KiB）或先用 `file_create` / `file_import` 写入工作区内 `.json`，再传 `data_path`（不超过 1 MiB）。`office_import_data` 把工作区内 CSV/TSV 导入现有 Excel 工作表。`office_extract_media` 将文档节点的二进制载荷保存为新文件；若为支持的图片或音频，会直接返回 MCP 媒体内容。`office_screenshot` 同样返回图片内容。`office_raw_set` 提供受 SHA-256 保护的 XPath/XML 编辑，适用于 DOM 工具不支持的细节。`office_refresh` 依赖 Windows 机器另装 Word，仅在需要刷新 Word 字段时调用。创建、模板合并、截图与媒体提取均拒绝覆盖已有文件。

远端 ChatGPT 可先用 `workspace_list` / `file_list` 找到授权文档，用 `office_view` 读取并取得 SHA-256，再调用编辑工具；生成的新 Office 文件留在本地工作区。上传到 ChatGPT 的素材可通过已有 `file_import` 下载到授权工作区，也可用 `file_create_binary` 创建小文件。插件只调用项目内固定版本 OfficeCLI，不向 ChatGPT 转发 OfficeCLI 自带的原始命令 MCP，文件路径始终经过项目授权工作区校验。

启用但未安装、校验失败或无法执行时，服务继续提供其他工具。`mcp_status` 报告插件状态，Office 工具返回本机安装命令；运行 `pnpm plugins:install` 后重启服务。安装脚本是唯一会下载插件文件的入口。新增项目内插件时，在 `scripts/install-plugins.mjs` 中登记其安装器，并在项目配置校验、JSON Schema 与服务注册处声明它的能力。
