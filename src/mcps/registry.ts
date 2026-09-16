import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logToolResult } from "../common/logger.ts";
import type { ExternalMcpConfig } from "./config.ts";
import { failure } from "../tools/shared.ts";
import { StdioMcpGateway } from "./stdio-gateway.ts";
import { validateExternalWorkspacePaths } from "./workspace.ts";

/** 创建并连接所有配置的外部 stdio MCP；单个失败不会阻止本地工具。 */
export async function loadExternalMcps(configs: ExternalMcpConfig[]): Promise<{ gateways: StdioMcpGateway[]; tools: Array<{ gateway: StdioMcpGateway; tool: Awaited<ReturnType<StdioMcpGateway["availableTools"]>>[number] }> }> {
  const gateways = configs.map((config) => new StdioMcpGateway(config));
  const result = await Promise.all(gateways.map(async (gateway) => (await gateway.availableTools()).map((tool) => ({ gateway, tool }))));
  return { gateways, tools: result.flat() };
}

/** 将上游 JSON Schema 和只读注解原样注册；同名工具由调用方提前排除。 */
export function registerExternalTools(server: McpServer, tools: Array<{ gateway: StdioMcpGateway; tool: Awaited<ReturnType<StdioMcpGateway["availableTools"]>>[number] }>): void {
  for (const { gateway, tool } of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description ?? `调用外部 MCP ${gateway.config.name} 的工具 ${tool.name}。`,
      inputSchema: z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      annotations: tool.annotations,
    }, async (args) => {
      try {
        if (!args || typeof args !== "object" || Array.isArray(args)) return failure("外部 MCP 工具参数必须是对象。");
        await validateExternalWorkspacePaths(args as Record<string, unknown>, gateway.config.workspacePathArguments);
        const result = await gateway.callTool(tool.name, args as Record<string, unknown>);
        if ("toolResult" in result) return failure("外部 MCP 返回了异步任务结果，当前服务不支持转发。");
        logToolResult(true);
        return result;
      } catch (error) {
        return failure(error);
      }
    });
  }
}
