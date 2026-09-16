import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { validateWorkspace } from "../../common/workspace.ts";

const executeFile = promisify(execFile);
const MAX_OUTPUT_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function runGit(repository: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await executeFile("git", ["--no-optional-locks", ...args], {
      cwd: repository,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git 命令失败：${message.slice(0, 1_000)}`);
  }
}

async function repositoryFor(workspaceInput: string): Promise<string> {
  const workspace = await validateWorkspace(workspaceInput);
  const repository = (await runGit(workspace, ["rev-parse", "--show-toplevel"])).trim();
  if (!repository || !isInside(workspace, repository)) throw new Error("Git 仓库根目录必须位于授权工作区内。");
  return repository;
}

/** 返回当前仓库分支和工作区修改状态。 */
export async function gitStatus(workspaceInput: string) {
  const repository = await repositoryFor(workspaceInput);
  return { repository, status: (await runGit(repository, ["status", "--short", "--branch"])).trimEnd() };
}

/** 返回未暂存或暂存的 Git 差异。 */
export async function gitDiff(workspaceInput: string, staged: boolean) {
  const repository = await repositoryFor(workspaceInput);
  return { repository, staged, diff: (await runGit(repository, ["diff", "--no-ext-diff", ...(staged ? ["--cached"] : []), "--stat", "--patch", "--"])).trimEnd() };
}

/** 返回最近提交的简要历史。 */
export async function gitLog(workspaceInput: string, limit: number) {
  const repository = await repositoryFor(workspaceInput);
  const output = await runGit(repository, ["log", `--max-count=${limit}`, "--format=%H%x09%h%x09%an%x09%aI%x09%s"]);
  const commits = output.trimEnd().split("\n").filter(Boolean).map((line) => {
    const [id = "", short_id = "", author = "", date = "", subject = ""] = line.split("\t", 5);
    return { id, short_id, author, date, subject };
  });
  return { repository, commits };
}

/** 返回本地分支及其上游分支。 */
export async function gitBranches(workspaceInput: string) {
  const repository = await repositoryFor(workspaceInput);
  const output = await runGit(repository, ["branch", "--format=%(refname:short)%x09%(HEAD)%x09%(upstream:short)"]);
  const branches = output.trimEnd().split("\n").filter(Boolean).map((line) => {
    const [name = "", current = "", upstream = ""] = line.split("\t", 3);
    return { name, current: current === "*", ...(upstream ? { upstream } : {}) };
  });
  return { repository, branches };
}
