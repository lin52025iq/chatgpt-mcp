import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ToolCall = { name: string; startedAt: number };

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const toolCalls = new AsyncLocalStorage<ToolCall>();

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]").slice(0, 1_000);
}

/** 向项目 logs 目录追加 JSON Lines 日志，不记录工具参数或返回内容。 */
class Logger {
  #pending = Promise.resolve();

  log(level: "INFO" | "WARN" | "ERROR", event: string, fields: Record<string, unknown> = {}): void {
    const now = new Date();
    const line = `${JSON.stringify({ timestamp: now.toISOString(), level, event, ...fields })}\n`;
    const file = path.join(projectRoot, "logs", `chatgpt-mcp-${now.toISOString().slice(0, 10)}.jsonl`);
    this.#pending = this.#pending.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line, "utf8");
    }).catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.#pending;
  }
}

export const logger = new Logger();

/** 让工具结果日志自动附带工具名和耗时。 */
export function withToolCall<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return toolCalls.run({ name, startedAt: Date.now() }, operation);
}

/** 记录工具执行结果；参数、文件内容和返回值不会写入日志。 */
export function logToolResult(ok: boolean, error?: unknown): void {
  const tool = toolCalls.getStore();
  if (!tool) return;
  logger.log(ok ? "INFO" : "WARN", ok ? "tool.call.completed" : "tool.call.failed", {
    tool: tool.name,
    duration_ms: Date.now() - tool.startedAt,
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  });
}

/** 将异常压缩为安全的一行日志文本。 */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  logger.log("ERROR", event, { ...fields, error: errorMessage(error) });
}
