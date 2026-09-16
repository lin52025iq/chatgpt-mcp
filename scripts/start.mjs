import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflaredStatus } from "./runtime/cloudflared.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawArguments = process.argv.slice(2);
const argumentsList = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
if (argumentsList.length !== 0 && (argumentsList.length !== 2 || argumentsList[0] !== "--config" || !argumentsList[1]?.trim())) throw new Error("仅支持 --config <配置文件路径> 启动参数。");
const publicUrl = process.env.CLOUDFLARE_MCP_URL;
if (!publicUrl) throw new Error("必须设置 CLOUDFLARE_MCP_URL。");
if (!process.env.TUNNEL_TOKEN) throw new Error("必须设置 TUNNEL_TOKEN。");

const status = await cloudflaredStatus(projectRoot);
if (status.state !== "ready" || !status.binary) throw new Error(`${status.message ?? "cloudflared 不可用。"} 请在项目目录运行 ${status.install_command ?? "pnpm runtime:install"}。`);
const environment = process.env;
const cloudflared = spawn(status.binary, ["tunnel", "--loglevel", environment.TUNNEL_LOGLEVEL?.trim() || "fatal", "run"], { env: environment, stdio: "ignore" });
const server = spawn(process.execPath, ["dist/index.js", ...argumentsList], { env: environment, stdio: "inherit" });
let stopping = false;
const stop = (name, code = 0) => {
  if (stopping) return;
  stopping = true;
  console.error(`[chatgpt-mcp] ${name} 已退出，正在关闭服务。`);
  cloudflared.kill();
  server.kill();
  process.exitCode = code;
};
cloudflared.once("error", (error) => { console.error(`[chatgpt-mcp] 无法启动 cloudflared：${error.message}`); stop("cloudflared", 1); });
server.once("error", (error) => { console.error(`[chatgpt-mcp] 无法启动 MCP：${error.message}`); stop("MCP", 1); });
cloudflared.once("exit", (code) => stop("cloudflared", code ?? 1));
server.once("exit", (code) => stop("MCP", code ?? 1));
