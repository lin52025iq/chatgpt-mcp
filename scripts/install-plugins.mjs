import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installOfficeCli } from "./plugins/officecli.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--config" || !args[1]?.trim())) throw new Error("仅支持 --config <配置文件路径> 参数。");
const configPath = path.resolve(projectRoot, args[1] ?? "config.json");

async function main() {
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { throw new Error(`无法读取有效的项目配置：${configPath}`, { cause: error }); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("项目配置根节点必须是对象。");
  const plugins = config.plugins ?? {};
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) throw new Error("项目配置 plugins 必须是对象。");
  const installers = { officecli: installOfficeCli };
  for (const [name, settings] of Object.entries(plugins)) {
    if (!Object.hasOwn(installers, name)) throw new Error(`未知插件：${name}。`);
    if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).some((key) => key !== "enabled") || typeof settings.enabled !== "boolean") throw new Error(`plugins.${name}.enabled 必须是布尔值，且不允许其他字段。`);
    if (!settings.enabled) continue;
    await installers[name](projectRoot);
  }
  console.error("[chatgpt-mcp] 已完成当前配置中启用插件的安装检查。");
}

await main().catch((error) => {
  console.error(`[chatgpt-mcp] 插件安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
