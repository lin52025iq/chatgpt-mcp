import { validateWorkspace } from "../common/workspace.ts";

/** 校验外部 MCP 指定的项目目录不会突破本服务的授权工作区。 */
export async function validateExternalWorkspacePaths(args: Record<string, unknown>, argumentNames: string[] | undefined): Promise<void> {
  if (!argumentNames?.length) return;
  for (const name of argumentNames) {
    const input = args[name];
    if (typeof input !== "string") throw new Error(`${name} 必须是授权工作区内不含 '..' 的绝对目录路径。`);
    await validateWorkspace(input, name);
  }
}
