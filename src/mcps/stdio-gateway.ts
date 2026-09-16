import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { logError, logger } from "../common/logger.ts";
import type { ExternalMcpConfig } from "./config.ts";

type RemoteTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** 一个受管的本机 stdio MCP 连接；仅收集上游显式声明为只读的工具。 */
export class StdioMcpGateway {
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;
  #tools: RemoteTool[] = [];
  #lastError: string | undefined;
  #closed = false;

  constructor(readonly config: ExternalMcpConfig) {}

  async availableTools(): Promise<RemoteTool[]> {
    try {
      const client = await this.#getClient();
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);
      this.#tools = tools.filter((tool) => tool.annotations?.readOnlyHint === true && (!this.config.toolAllowlist || this.config.toolAllowlist.includes(tool.name)));
      this.#lastError = undefined;
      logger.log("INFO", "external_mcp.tools_loaded", { mcp: this.config.name, tool_count: this.#tools.length });
      return this.#tools;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      logError("external_mcp.tools_load_failed", error, { mcp: this.config.name });
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.#tools.some((tool) => tool.name === name)) throw new Error(`外部 MCP ${this.config.name} 未启用工具：${name}`);
    return (await this.#getClient()).callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  }

  status() {
    return { name: this.config.name, connected: this.#client !== undefined, exposed_tools: this.#tools.map((tool) => tool.name), ...(this.#lastError ? { last_error: this.#lastError } : {}) };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#connecting?.catch(() => undefined);
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
    logger.log("INFO", "external_mcp.disconnected", { mcp: this.config.name });
  }

  async #getClient(): Promise<Client> {
    if (this.#closed) throw new Error(`外部 MCP ${this.config.name} 已关闭。`);
    if (this.#client) return this.#client;
    if (!this.#connecting) this.#connecting = this.#connect().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  async #connect(): Promise<Client> {
    logger.log("INFO", "external_mcp.connecting", { mcp: this.config.name, command: this.config.command });
    const client = new Client({ name: "chatgpt-mcp", version: "0.1.0" });
    const inheritedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) inheritedEnv[key] = value;
    const env = this.config.env ? { ...inheritedEnv, ...this.config.env } : undefined;
    const transport = new StdioClientTransport({ command: this.config.command, args: this.config.args, env, stderr: "inherit" });
    client.onclose = () => { if (this.#client === client) this.#client = undefined; };
    try {
      await client.connect(transport, { timeout: 30_000 });
      if (this.#closed) throw new Error(`外部 MCP ${this.config.name} 已关闭。`);
      this.#client = client;
      logger.log("INFO", "external_mcp.connected", { mcp: this.config.name });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      logError("external_mcp.connection_failed", error, { mcp: this.config.name });
      throw error;
    }
  }
}
