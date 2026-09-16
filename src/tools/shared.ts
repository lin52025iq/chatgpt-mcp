import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { logToolResult } from "../common/logger.ts";

/** 将成功数据统一返回为文本和结构化 MCP 内容。 */
export function success(data: unknown): CallToolResult {
  logToolResult(true);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { data } };
}

/** 返回原生 MCP 内容块，用于图片和音频等非文本结果。 */
export function successContent(content: CallToolResult["content"]): CallToolResult {
  logToolResult(true);
  return { content };
}

/** 将异常转换为不泄露堆栈的 MCP 错误。 */
export function failure(error: unknown): CallToolResult {
  logToolResult(false, error);
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}
