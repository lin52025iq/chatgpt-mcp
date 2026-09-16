import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorizedWorkspaces, validateWorkspace } from "../../common/workspace.ts";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 2_000;
const TRASH_DIRECTORY = ".chatgpt-mcp-trash";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function assertRelative(relativePath: string, allowCurrentDirectory = false): void {
  if ((!allowCurrentDirectory && !relativePath) || path.isAbsolute(relativePath) || relativePath.includes("\0") || relativePath.split(/[\\/]/u).includes("..") || relativePath.split(/[\\/]/u).includes(TRASH_DIRECTORY)) throw new Error("path 必须是工作区内不包含 '..' 或回收目录的相对路径。");
}

export async function existingFile(workspaceInput: string, relativePath: string) {
  const workspace = await validateWorkspace(workspaceInput);
  assertRelative(relativePath);
  const file = await realpath(path.resolve(workspace, relativePath));
  if (!isInside(workspace, file) || !(await stat(file)).isFile()) throw new Error("目标路径不是工作区内的文件。");
  return { workspace, file };
}

export async function writableFile(workspaceInput: string, relativePath: string, mustExist: boolean) {
  const workspace = await validateWorkspace(workspaceInput);
  assertRelative(relativePath);
  const candidate = path.resolve(workspace, relativePath);
  if (!isInside(workspace, candidate)) throw new Error("目标路径不在工作区内。");
  const parent = await realpath(path.dirname(candidate));
  if (!isInside(workspace, parent) || !(await stat(parent)).isDirectory()) throw new Error("目标父目录不是工作区内的目录。");
  const file = path.join(parent, path.basename(candidate));
  try {
    const resolved = await realpath(file);
    if (!isInside(workspace, resolved) || !(await stat(resolved)).isFile()) throw new Error("目标路径不是工作区内的文件。");
    return { workspace, file: resolved, exists: true };
  } catch (error) {
    if (mustExist || !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    return { workspace, file, exists: false };
  }
}

function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

/** 列出受授权的工作区。 */
export async function listWorkspaces() {
  return { workspaces: await authorizedWorkspaces() };
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

/** 读取不超过 512 KiB 的 UTF-8 文件，并返回更新/删除所需的 SHA-256。 */
export async function readTextFile(workspaceInput: string, relativePath: string) {
  const target = await existingFile(workspaceInput, relativePath);
  if ((await stat(target.file)).size > MAX_FILE_BYTES) throw new Error("文件超过 512 KiB 限制。");
  const content = await readFile(target.file);
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new Error("文件不是有效的 UTF-8 文本；图片或音频请使用 media_read。"); }
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), sha256: sha256(content), content: content.toString("utf8") };
}

/** 在已有父目录下创建新的 UTF-8 文件。 */
export async function createTextFile(workspaceInput: string, relativePath: string, content: string) {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("文件内容超过 512 KiB 限制。");
  const target = await writableFile(workspaceInput, relativePath, false);
  if (target.exists) throw new Error("目标文件已存在，请使用 file_write 更新。");
  await writeFile(target.file, content, { encoding: "utf8", flag: "wx" });
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), created: true, sha256: sha256(Buffer.from(content)) };
}

type PatchHunk = { oldLines: string[]; newLines: string[]; changed: boolean; hasContext: boolean };

function parsePatch(patch: string): PatchHunk[] {
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { oldLines: [], newLines: [], changed: false, hasContext: false };
      continue;
    }
    if (!current || ![" ", "+", "-"].includes(line[0] ?? "")) throw new Error("patch 必须由 @@ 区块及以空格、+、- 开头的行组成。");
    const text = line.slice(1);
    if (line.startsWith(" ")) { current.oldLines.push(text); current.newLines.push(text); current.hasContext = true; }
    if (line.startsWith("-")) { current.oldLines.push(text); current.changed = true; }
    if (line.startsWith("+")) { current.newLines.push(text); current.changed = true; }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0 || hunks.some((hunk) => !hunk.changed || !hunk.hasContext)) throw new Error("每个 patch 区块必须以 @@ 开始，包含变更，并至少提供一行以空格开头的原始上下文。");
  return hunks;
}

function locateHunk(lines: string[], expected: string[], from: number): number {
  let matched = -1;
  for (let index = from; index <= lines.length - expected.length; index += 1) {
    if (!expected.every((line, offset) => lines[index + offset] === line)) continue;
    if (matched >= 0) throw new Error("patch 上下文匹配到多个位置，请增加区块上下文或使用 @@ 标记说明函数/类。");
    matched = index;
  }
  if (matched < 0) throw new Error("patch 上下文无法应用，请重新读取文件后生成补丁。");
  return matched;
}

/** 应用 Codex 风格的 @@ 上下文补丁；调用方必须提交刚读取到的 SHA-256。 */
export async function patchTextFile(workspaceInput: string, relativePath: string, patch: string, expectedSha256: string) {
  const target = await writableFile(workspaceInput, relativePath, true);
  const original = await readFile(target.file);
  if (sha256(original) !== expectedSha256) throw new Error("文件内容已变化，请重新调用 file_read 后再应用补丁。");
  const source = original.toString("utf8");
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  let cursor = 0;
  const hunks = parsePatch(patch);
  for (const hunk of hunks) {
    const index = locateHunk(lines, hunk.oldLines, cursor);
    lines.splice(index, hunk.oldLines.length, ...hunk.newLines);
    cursor = index + hunk.newLines.length;
  }
  const content = lines.join(lineEnding);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("编辑后的文件超过 512 KiB 限制。");
  await writeFile(target.file, content, "utf8");
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, hunks_applied: hunks.length, sha256: sha256(Buffer.from(content)) };
}

/** 用完整内容更新文件；调用方必须提交刚读取到的 SHA-256。 */
export async function writeTextFile(workspaceInput: string, relativePath: string, content: string, expectedSha256: string) {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("文件内容超过 512 KiB 限制。");
  const target = await writableFile(workspaceInput, relativePath, true);
  if (sha256(await readFile(target.file)) !== expectedSha256) throw new Error("文件内容已变化，请重新调用 file_read 后再更新。");
  await writeFile(target.file, content, "utf8");
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: sha256(Buffer.from(content)) };
}

/** 将文件移动到工作区回收目录，避免远端调用不可恢复地删除数据。 */
export async function deleteTextFile(workspaceInput: string, relativePath: string, expectedSha256: string) {
  const target = await writableFile(workspaceInput, relativePath, true);
  if (sha256(await readFile(target.file)) !== expectedSha256) throw new Error("文件内容已变化，请重新调用 file_read 后再删除。");
  const trash = path.join(target.workspace, TRASH_DIRECTORY);
  await mkdir(trash, { recursive: true });
  const trashPath = path.join(trash, `${Date.now()}-${randomUUID()}-${path.basename(target.file)}`);
  await rename(target.file, trashPath);
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), deleted: true, trash_path: path.relative(target.workspace, trashPath) };
}
