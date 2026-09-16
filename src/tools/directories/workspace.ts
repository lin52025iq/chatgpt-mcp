import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { validateWorkspace } from "../../common/workspace.ts";

const MAX_LIST_ENTRIES = 2_000;
const TRASH_DIRECTORY = ".chatgpt-mcp-trash";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function assertRelative(relativePath: string, allowCurrentDirectory = false): void {
  if ((!allowCurrentDirectory && !relativePath) || path.isAbsolute(relativePath) || relativePath.includes("\0") || relativePath.split(/[\\/]/u).includes("..") || relativePath.split(/[\\/]/u).includes(TRASH_DIRECTORY)) throw new Error("path 必须是工作区内不包含 '..' 或回收目录的相对路径。");
}

async function existingDirectory(workspaceInput: string, relativePath: string) {
  const workspace = await validateWorkspace(workspaceInput);
  assertRelative(relativePath);
  const directory = await realpath(path.resolve(workspace, relativePath));
  if (directory === workspace || !isInside(workspace, directory) || !(await stat(directory)).isDirectory()) throw new Error("目标路径必须是工作区内的非根目录。");
  return { workspace, directory };
}

async function newDirectoryPath(workspace: string, relativePath: string): Promise<string> {
  assertRelative(relativePath);
  const candidate = path.resolve(workspace, relativePath);
  if (!isInside(workspace, candidate)) throw new Error("目标路径不在工作区内。");
  const parent = await realpath(path.dirname(candidate));
  if (!isInside(workspace, parent) || !(await stat(parent)).isDirectory()) throw new Error("目标父目录不是工作区内的目录。");
  const directory = path.join(parent, path.basename(candidate));
  try { await lstat(directory); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return directory;
    throw error;
  }
  throw new Error("目标路径已存在。");
}

/** 列出工作区目录的直接子项，不跟随符号链接。 */
export async function listDirectory(workspaceInput: string, relativePath = ".") {
  const workspace = await validateWorkspace(workspaceInput);
  assertRelative(relativePath, true);
  const directory = await realpath(path.resolve(workspace, relativePath));
  if (!isInside(workspace, directory) || !(await stat(directory)).isDirectory()) throw new Error("目标路径不是工作区内的目录。");
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_LIST_ENTRIES) throw new Error(`目录项目超过 ${MAX_LIST_ENTRIES} 项限制，请指定更深的 path。`);
  return { workspace, path: path.relative(workspace, directory) || ".", entries: entries.filter((entry) => entry.name !== TRASH_DIRECTORY).sort((left, right) => left.name.localeCompare(right.name)).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other" })) };
}

/** 在工作区内创建目录及缺失的父目录；拒绝符号链接逃逸。 */
export async function createDirectory(workspaceInput: string, relativePath: string) {
  const workspace = await validateWorkspace(workspaceInput);
  assertRelative(relativePath);
  const segments = relativePath.split(/[\\/]/u).filter((segment) => segment && segment !== ".");
  let directory = workspace;
  let created = false;
  for (const segment of segments) {
    const candidate = path.join(directory, segment);
    try { await mkdir(candidate); created = true; } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
    directory = await realpath(candidate);
    if (!isInside(workspace, directory) || !(await stat(directory)).isDirectory()) throw new Error("目标路径不是工作区内的目录。");
  }
  return { workspace, path: path.relative(workspace, directory), created };
}

/** 在同一工作区内移动或重命名目录；目标父目录必须已存在。 */
export async function moveDirectory(workspaceInput: string, fromPath: string, toPath: string) {
  const source = await existingDirectory(workspaceInput, fromPath);
  const destination = await newDirectoryPath(source.workspace, toPath);
  if (isInside(source.directory, destination)) throw new Error("不能将目录移动到自身内部。");
  await rename(source.directory, destination);
  return { workspace: source.workspace, from_path: path.relative(source.workspace, source.directory), to_path: path.relative(source.workspace, destination), moved: true };
}

/** 将目录移动到工作区回收目录；不会递归销毁其内容。 */
export async function deleteDirectory(workspaceInput: string, relativePath: string) {
  const source = await existingDirectory(workspaceInput, relativePath);
  const trash = path.join(source.workspace, TRASH_DIRECTORY);
  await mkdir(trash, { recursive: true });
  const trashPath = path.join(trash, `${Date.now()}-${randomUUID()}-${path.basename(source.directory)}`);
  await rename(source.directory, trashPath);
  return { workspace: source.workspace, path: path.relative(source.workspace, source.directory), deleted: true, trash_path: path.relative(source.workspace, trashPath) };
}
