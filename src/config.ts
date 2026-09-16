import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ProjectConfig = {
  workspaceGrants: string[];
  fileWritesEnabled: boolean;
  plugins?: Record<string, { enabled: boolean }>;
  mcpServers?: Record<string, unknown>;
  allowNonLoopback?: boolean;
  allowedHosts?: string[];
};

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawArguments = process.argv.slice(2);
const argumentsList = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
if (argumentsList.length !== 0 && (argumentsList.length !== 2 || argumentsList[0] !== "--config" || !argumentsList[1]?.trim())) throw new Error("仅支持 --config <配置文件路径> 启动参数。");
export const configPath = path.resolve(projectRoot, argumentsList[1] ?? "config.json");

function validWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && !value.split(/[\\/]/u).includes("..");
}

/** 读取启动参数选定的项目配置；缺失或无效时拒绝启动。 */
function loadProjectConfig(): ProjectConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (error) { throw new Error(`无法读取有效的项目配置：${configPath}`, { cause: error }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("项目配置根节点必须是对象。");
  const config = parsed as Record<string, unknown>;
  if (!Array.isArray(config.workspaceGrants) || !config.workspaceGrants.every(validWorkspacePath)) throw new Error("项目配置 workspaceGrants 必须是绝对路径数组。");
  if (typeof config.fileWritesEnabled !== "boolean") throw new Error("项目配置 fileWritesEnabled 必须是布尔值。");
  if (config.plugins !== undefined) {
    if (!config.plugins || typeof config.plugins !== "object" || Array.isArray(config.plugins)) throw new Error("项目配置 plugins 必须是对象。");
    for (const [name, value] of Object.entries(config.plugins)) {
      if (name !== "officecli" || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`未知或无效的项目插件：${name}。`);
      const settings = value as Record<string, unknown>;
      if (Object.keys(settings).some((key) => key !== "enabled") || typeof settings.enabled !== "boolean") throw new Error(`plugins.${name}.enabled 必须是布尔值，且不允许其他字段。`);
    }
  }
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) throw new Error("项目配置 mcpServers 必须是对象。");
  if (config.allowNonLoopback !== undefined && typeof config.allowNonLoopback !== "boolean") throw new Error("项目配置 allowNonLoopback 必须是布尔值。");
  if (config.allowedHosts !== undefined && (!Array.isArray(config.allowedHosts) || config.allowedHosts.some((host) => typeof host !== "string" || !host.trim()))) throw new Error("项目配置 allowedHosts 必须是主机名数组。");
  return config as ProjectConfig;
}

export const projectConfig = loadProjectConfig();

export type RuntimeConfig = {
  host: string;
  port: number;
  mcpPath: string;
  allowedHosts: string[];
  fileWritesEnabled: boolean;
  plugins: Record<string, { enabled: boolean }>;
};

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`PORT 无效：${raw}`);
  return port;
}

function isLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || (net.isIP(normalized) === 4 && normalized.startsWith("127."));
}

/** 读取并校验运行配置；公网端点路径由 CLOUDFLARE_MCP_URL 唯一决定。 */
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  if (!isLoopback(host) && !projectConfig.allowNonLoopback) throw new Error("HOST 必须是回环地址；非回环监听需在项目配置中设置 allowNonLoopback=true。");
  const port = parsePort(env.PORT ?? "8787");
  const publicUrl = env.CLOUDFLARE_MCP_URL?.trim();
  let mcpPath = "/mcp";
  let publicHost: string | undefined;
  if (publicUrl) {
    let parsed: URL;
    try { parsed = new URL(publicUrl); } catch { throw new Error("CLOUDFLARE_MCP_URL 必须是有效的绝对 URL。"); }
    if (parsed.protocol !== "https:" || parsed.search || parsed.hash) throw new Error("CLOUDFLARE_MCP_URL 必须是无查询参数和片段的 HTTPS 地址。");
    mcpPath = parsed.pathname;
    publicHost = parsed.host;
  }
  const fileWritesEnabled = projectConfig.fileWritesEnabled;
  const additionalHosts = [...(projectConfig.allowedHosts ?? []), ...(publicHost ? [publicHost] : [])];
  const hostNames = new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...additionalHosts]);
  return { host, port, mcpPath, allowedHosts: [...hostNames], fileWritesEnabled, plugins: projectConfig.plugins ?? {} };
}
