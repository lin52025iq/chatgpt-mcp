import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { failure, success } from "../shared.ts";
import { gitBranches, gitDiff, gitLog, gitStatus } from "./repository.ts";

/** 注册受授权工作区范围限制的只读 Git 工具。 */
export function registerGitTools(server: McpServer): void {
  server.registerTool("git_status", { title: "查看 Git 状态", description: "返回授权工作区内 Git 仓库的当前分支与工作区状态。", inputSchema: { workspace: z.string().min(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace }) => { try { return success(await gitStatus(workspace)); } catch (error) { return failure(error); } });
  server.registerTool("git_diff", { title: "查看 Git 差异", description: "返回授权工作区内 Git 仓库的未暂存或暂存差异。", inputSchema: { workspace: z.string().min(1), staged: z.boolean().optional().default(false) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, staged }) => { try { return success(await gitDiff(workspace, staged)); } catch (error) { return failure(error); } });
  server.registerTool("git_log", { title: "查看 Git 提交历史", description: "返回授权工作区内 Git 仓库最近的提交摘要。", inputSchema: { workspace: z.string().min(1), limit: z.number().int().min(1).max(100).optional().default(20) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, limit }) => { try { return success(await gitLog(workspace, limit)); } catch (error) { return failure(error); } });
  server.registerTool("git_branch_list", { title: "列出 Git 分支", description: "返回授权工作区内 Git 仓库的本地分支与上游分支。", inputSchema: { workspace: z.string().min(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace }) => { try { return success(await gitBranches(workspace)); } catch (error) { return failure(error); } });
}
