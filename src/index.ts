import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { logError, logger, withToolCall } from "./common/logger.ts";
import { runtimeConfig } from "./config.ts";
import { loadMcpConfig } from "./mcps/config.ts";
import { loadExternalMcps } from "./mcps/registry.ts";
import { OFFICECLI_EXTENDED_READ_NAMES, OFFICECLI_EXTENDED_WRITE_NAMES } from "./plugins/officecli/extended.ts";
import { OFFICECLI_READ_TOOL_NAMES, OFFICECLI_WRITE_TOOL_NAMES } from "./plugins/officecli/module.ts";
import { officeCliStatus } from "./plugins/officecli/runtime.ts";
import { createServer } from "./server.ts";

type Session = { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createServer> };

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("MCP 请求体过大。");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : undefined;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function requestInfo(body: unknown): { method: string; tool?: string } {
  if (!body || typeof body !== "object") return { method: "unknown" };
  const message = body as Record<string, unknown>;
  const method = typeof message.method === "string" ? message.method : "unknown";
  const params = message.params;
  const tool = params && typeof params === "object" && !Array.isArray(params) && typeof (params as Record<string, unknown>).name === "string"
    ? (params as Record<string, unknown>).name as string
    : undefined;
  return { method, ...(tool ? { tool } : {}) };
}

async function main(): Promise<void> {
  const config = runtimeConfig();
  const { gateways, tools } = await loadExternalMcps(loadMcpConfig());
  const officecli = await officeCliStatus(config.plugins.officecli?.enabled === true);
  const pluginTools = config.plugins.officecli?.enabled ? [...OFFICECLI_READ_TOOL_NAMES, ...OFFICECLI_EXTENDED_READ_NAMES, ...(config.fileWritesEnabled ? [...OFFICECLI_WRITE_TOOL_NAMES, ...OFFICECLI_EXTENDED_WRITE_NAMES] : [])] : [];
  logger.log("INFO", "service.starting", { host: config.host, port: config.port, external_mcp_count: gateways.length });
  const toolNames = new Set(["mcp_status", "workspace_list", "file_list", "file_read", "media_read", "directory_create", "directory_list", "directory_move", "directory_delete", "file_create", "file_create_binary", "file_import", "file_patch", "file_write", "file_delete", "git_status", "git_diff", "git_log", "git_branch_list"]);
  pluginTools.forEach((name) => toolNames.add(name));
  const externalTools = tools.filter(({ gateway, tool }) => {
    if (toolNames.has(tool.name)) {
      console.error(`[chatgpt-mcp] 跳过外部 MCP ${gateway.config.name} 的同名工具：${tool.name}`);
      logger.log("WARN", "external_mcp.tool_skipped", { mcp: gateway.config.name, tool: tool.name, reason: "duplicate_name" });
      return false;
    }
    toolNames.add(tool.name);
    return true;
  });
  const registeredMcps = new Map<string, string[]>();
  for (const { gateway, tool } of externalTools) {
    const names = registeredMcps.get(gateway.config.name) ?? [];
    names.push(tool.name);
    registeredMcps.set(gateway.config.name, names);
  }
  for (const [name, names] of registeredMcps) {
    const detail = names.length <= 10 ? `：${names.join(", ")}` : "";
    console.error(`[chatgpt-mcp] 外部 MCP 已注册：${name}（${names.length} 个只读工具${detail}）`);
    logger.log("INFO", "external_mcp.registered", { mcp: name, tool_count: names.length, tools: names });
  }
  console.error(`[chatgpt-mcp] 外部 MCP 注册完成：${registeredMcps.size} 个服务，${externalTools.length} 个只读工具。`);
  if (pluginTools.length > 0) {
    const stateName = { ready: "可用", missing: "未安装", invalid: "安装无效", unsupported: "平台不支持", disabled: "未启用" }[officecli.state];
    console.error(`[chatgpt-mcp] 项目插件已注册：officecli（版本 ${officecli.version}，状态 ${stateName}，${pluginTools.length} 个工具）`);
    logger.log("INFO", "plugin.registered", { plugin: "officecli", version: officecli.version, state: officecli.state, tool_count: pluginTools.length, tools: pluginTools });
    if (officecli.state !== "ready") {
      console.error(`[chatgpt-mcp] OfficeCLI 不可用：${officecli.message ?? "请检查插件安装。"}${officecli.install_command ? ` 请运行 ${officecli.install_command}，然后重启服务。` : ""}`);
      logger.log("WARN", "plugin.unavailable", { plugin: "officecli", state: officecli.state, message: officecli.message, install_command: officecli.install_command });
    }
  }
  console.error(`[chatgpt-mcp] 项目插件注册完成：${pluginTools.length > 0 ? 1 : 0} 个已启用插件，${pluginTools.length} 个工具。`);
  logger.log("INFO", "plugins.registered", { plugin_count: pluginTools.length > 0 ? 1 : 0, tool_count: pluginTools.length });
  const sessions = new Map<string, Session>();

  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const sessionId = header(request, "mcp-session-id");
    if (request.method === "POST") {
      let body: unknown;
      try { body = await readJsonBody(request); } catch (error) { logError("mcp.request_invalid", error); writeJson(response, 400, { jsonrpc: "2.0", error: { code: -32700, message: error instanceof Error ? error.message : "JSON 无效。" }, id: null }); return; }
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session && !sessionId && isInitializeRequest(body)) {
        let transport: StreamableHTTPServerTransport;
        const server = createServer(config, gateways, externalTools);
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: config.allowedHosts, onsessioninitialized: (id) => { sessions.set(id, { transport, server }); logger.log("INFO", "mcp.session.connected", { session_id: id }); } });
        transport.onclose = () => { if (transport.sessionId) { sessions.delete(transport.sessionId); logger.log("INFO", "mcp.session.disconnected", { session_id: transport.sessionId }); } };
        await server.connect(transport);
        session = { transport, server };
      }
      if (!session) { writeJson(response, 400, { jsonrpc: "2.0", error: { code: -32000, message: "需要有效的 mcp-session-id。" }, id: null }); return; }
      const info = requestInfo(body);
      logger.log("INFO", "mcp.request.received", info);
      const operation = () => session.transport.handleRequest(request, response, body);
      if (info.method === "tools/call" && info.tool) await withToolCall(info.tool, operation);
      else await operation();
      logger.log("INFO", "mcp.request.completed", info);
      return;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) { writeJson(response, sessionId ? 404 : 400, { jsonrpc: "2.0", error: { code: -32000, message: "需要有效的 mcp-session-id。" }, id: null }); return; }
      await session.transport.handleRequest(request, response);
      return;
    }
    response.setHeader("Allow", "GET, POST, DELETE");
    writeJson(response, 405, { jsonrpc: "2.0", error: { code: -32601, message: "不支持此 HTTP 方法。" }, id: null });
  };

  const httpServer = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/healthz") writeJson(response, 200, { ok: true, service: "chatgpt-mcp" });
      else if (url.pathname === "/readyz") writeJson(response, 200, { ready: true, service: "chatgpt-mcp", plugins: { officecli: await officeCliStatus(config.plugins.officecli?.enabled === true) }, external_mcp_count: gateways.length, exposed_external_tool_count: externalTools.length });
      else if (url.pathname === config.mcpPath) await handleMcp(request, response);
      else writeJson(response, 404, { error: "未找到资源。" });
    } catch (error) {
      logError("http.request_failed", error, { method: request.method ?? "unknown" });
      if (!response.headersSent) writeJson(response, 500, { jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "内部错误。" }, id: null });
    }
  });

  const shutdown = async (): Promise<void> => {
    logger.log("INFO", "service.stopping", { active_sessions: sessions.size });
    for (const session of sessions.values()) await session.transport.close().catch(() => undefined);
    await Promise.all(gateways.map((gateway) => gateway.close()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    logger.log("INFO", "service.stopped");
    await logger.flush();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  httpServer.listen(config.port, config.host, () => {
    console.error(`[chatgpt-mcp] MCP Streamable HTTP：http://${config.host}:${config.port}${config.mcpPath === "/mcp" ? "/mcp" : "/<受保护路径>"}`);
    logger.log("INFO", "service.started", { host: config.host, port: config.port });
  });
}

void main().catch(async (error: unknown) => {
  console.error(`[chatgpt-mcp] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  logError("service.start_failed", error);
  await logger.flush();
  process.exitCode = 1;
});
