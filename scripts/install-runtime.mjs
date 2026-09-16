import path from "node:path";
import { fileURLToPath } from "node:url";

import { installCloudflared } from "./runtime/cloudflared.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await installCloudflared(projectRoot).catch((error) => {
  console.error(`[chatgpt-mcp] Runtime 安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
