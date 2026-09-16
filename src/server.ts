import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RuntimeConfig } from "./config.ts";
import { registerExternalTools } from "./mcps/registry.ts";
import type { StdioMcpGateway } from "./mcps/stdio-gateway.ts";
import { registerOfficeCliExtendedTools } from "./plugins/officecli/extended.ts";
import { registerOfficeCliTools } from "./plugins/officecli/module.ts";
import { officeCliStatus } from "./plugins/officecli/runtime.ts";
import { registerDirectoryTools } from "./tools/directories/module.ts";
import { registerFileTools } from "./tools/files/module.ts";
import { registerGitTools } from "./tools/git/module.ts";
import { failure, success } from "./tools/shared.ts";

/** 创建一个会话专属 MCP Server，并注册本地与外部只读工具。 */
export function createServer(config: RuntimeConfig, gateways: StdioMcpGateway[], externalTools: Parameters<typeof registerExternalTools>[1]): McpServer {
  const server = new McpServer({ name: "chatgpt-mcp", version: "0.1.0" });
  server.registerTool("mcp_status", { title: "查看本地 MCP 状态", description: "返回本地文件写开关、项目插件安装状态和已连接外部 MCP 的工具状态。", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async () => {
    try { return success({ file_writes_enabled: config.fileWritesEnabled, plugins: { officecli: await officeCliStatus(config.plugins.officecli?.enabled === true) }, external_mcps: gateways.map((gateway) => gateway.status()) }); } catch (error) { return failure(error); }
  });
  registerFileTools(server, config.fileWritesEnabled);
  registerDirectoryTools(server, config.fileWritesEnabled);
  registerGitTools(server);
  registerOfficeCliTools(server, config.fileWritesEnabled, config.plugins.officecli?.enabled === true);
  registerOfficeCliExtendedTools(server, config.fileWritesEnabled, config.plugins.officecli?.enabled === true);
  registerExternalTools(server, externalTools);
  return server;
}
