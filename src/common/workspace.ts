import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { projectConfig, projectRoot } from "../config.ts";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function validAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes("\0") && !value.split(/[\\/]/u).includes("..");
}

/** 返回显式授权目录；空数组时仅授权项目内默认 workspace 目录。 */
export async function authorizedWorkspaces(): Promise<string[]> {
  const entries = projectConfig.workspaceGrants.length > 0 ? projectConfig.workspaceGrants : [path.join(projectRoot, "workspace")];
  const resolved = await Promise.all(entries.map(async (entry) => {
    if (!validAbsolutePath(entry)) throw new Error(`无效的授权工作区路径：${entry}`);
    const workspace = await realpath(entry);
    if (!(await stat(workspace)).isDirectory()) throw new Error(`授权工作区不是现有目录：${entry}`);
    return workspace;
  }));
  return [...new Set(resolved)].sort();
}

/** 解析工作区并确保它位于一个显式或默认授权目录内。 */
export async function validateWorkspace(input: string, name = "workspace"): Promise<string> {
  if (!input || !validAbsolutePath(input)) throw new Error(`${name} 必须是授权工作区内不含 '..' 的绝对目录路径。`);
  const workspace = await realpath(input);
  if (!(await stat(workspace)).isDirectory()) throw new Error(`${name} 必须是现有目录。`);
  const allowed = await authorizedWorkspaces();
  if (!allowed.some((grant) => isInside(grant, workspace))) throw new Error(`${name} 不在 workspaceGrants 授权范围内。`);
  return workspace;
}
