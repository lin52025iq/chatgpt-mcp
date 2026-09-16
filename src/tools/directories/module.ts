import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { failure, success } from "../shared.ts";
import { createDirectory, deleteDirectory, listDirectory, moveDirectory } from "./workspace.ts";

/** 注册本地受授权工作区的目录工具。 */
export function registerDirectoryTools(server: McpServer, writesEnabled: boolean): void {
  server.registerTool("directory_list", { title: "列出工作区目录", description: "列出授权工作区内目录的直接子项，不跟随符号链接。", inputSchema: { workspace: z.string().min(1), path: z.string().optional().default(".") }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path }) => { try { return success(await listDirectory(workspace, path)); } catch (error) { return failure(error); } });
  if (!writesEnabled) return;
  server.registerTool("directory_create", { title: "创建工作区目录", description: "在授权工作区内递归创建目录；已存在时不修改。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path }) => { try { return success(await createDirectory(workspace, path)); } catch (error) { return failure(error); } });
  server.registerTool("directory_move", { title: "移动或重命名工作区目录", description: "在同一授权工作区内移动或重命名目录；目标父目录必须已存在。", inputSchema: { workspace: z.string().min(1), from_path: z.string().min(1), to_path: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async ({ workspace, from_path, to_path }) => { try { return success(await moveDirectory(workspace, from_path, to_path)); } catch (error) { return failure(error); } });
  server.registerTool("directory_delete", { title: "删除工作区目录", description: "将目录移入工作区 .chatgpt-mcp-trash 回收目录，不递归销毁内容。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path }) => { try { return success(await deleteDirectory(workspace, path)); } catch (error) { return failure(error); } });
}
