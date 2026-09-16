import path from "node:path";
import { projectConfig } from "../config.ts";

export type ExternalMcpConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  toolAllowlist?: string[];
  workspacePathArguments?: string[];
};

function expandEnvironment(value: string): string {
  return value.replace(/\$\{env:([A-Z][A-Z0-9_]*)(?:\[(\d+)\])?(?::-(?:env:)?([A-Z][A-Z0-9_]*))?\}/gu, (_, name: string, index: string | undefined, fallback: string | undefined) => {
    const raw = process.env[name];
    const selected = index === undefined ? raw : (raw ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean)[Number(index)];
    const result = selected || (fallback ? process.env[fallback] : undefined);
    if (!result) throw new Error(`环境变量 ${name} 未设置，无法展开 MCP 配置。`);
    return result;
  });
}

function parseServer(name: string, value: unknown): ExternalMcpConfig {
  if (!/^[a-z0-9-]+$/u.test(name) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`mcpServers.${name} 无效。`);
  const { command, args = [], env, toolAllowlist, workspacePathArguments } = value as Record<string, unknown>;
  if (typeof command !== "string" || !command.trim()) throw new Error(`mcpServers.${name}.command 必须是非空字符串。`);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error(`mcpServers.${name}.args 必须是字符串数组。`);
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((item) => typeof item !== "string"))) throw new Error(`mcpServers.${name}.env 必须是字符串键值对象。`);
  if (toolAllowlist !== undefined && (!Array.isArray(toolAllowlist) || toolAllowlist.some((tool) => typeof tool !== "string" || !tool.trim()))) throw new Error(`mcpServers.${name}.toolAllowlist 必须是字符串数组。`);
  if (workspacePathArguments !== undefined && (!Array.isArray(workspacePathArguments) || workspacePathArguments.some((arg) => typeof arg !== "string" || !arg.trim()))) throw new Error(`mcpServers.${name}.workspacePathArguments 必须是字符串数组。`);
  const childEnv = env && Object.fromEntries(Object.entries(env as Record<string, string>).map(([key, item]) => [key, expandEnvironment(item)]));
  return { name, command: expandEnvironment(command.trim()), args: args.map(expandEnvironment), ...(childEnv ? { env: childEnv } : {}), ...(toolAllowlist ? { toolAllowlist: toolAllowlist as string[] } : {}), ...(workspacePathArguments ? { workspacePathArguments: workspacePathArguments as string[] } : {}) };
}

/** 从当前选定配置的 mcpServers 读取并校验本机 stdio MCP 定义。 */
export function loadMcpConfig(): ExternalMcpConfig[] {
  return Object.entries(projectConfig.mcpServers ?? {}).map(([name, value]) => parseServer(name, value));
}
