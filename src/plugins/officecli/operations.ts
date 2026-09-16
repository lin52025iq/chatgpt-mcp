import { readFile, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { existingFile } from "../../tools/files/workspace.ts";

type Scalar = string | number | boolean;
export type EditCommand = {
  command: "set" | "add" | "remove" | "move" | "swap";
  path?: string;
  parent?: string;
  type?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
  path2?: string;
  index?: number;
  props?: Record<string, Scalar>;
  file_properties?: Record<string, string>;
};

const writeLocks = new Map<string, Promise<void>>();
const FILE_KEYS = new Set(["src", "path", "preview", "image", "nativepath", "background"]);

/** 同一进程内串行处理同一 Office 文件，避免并发批次覆盖彼此的结果。 */
export async function withOfficeWriteLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => completed);
  writeLocks.set(file, tail);
  await previous;
  try { return await work(); }
  finally { release(); if (writeLocks.get(file) === tail) writeLocks.delete(file); }
}

function domPath(value: string | undefined, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || !value.startsWith("/") || value.includes("\0") || value.length > 1024) throw new Error(`${name} 必须是以 / 开始的 OfficeCLI DOM 路径。`);
  return value;
}

function scalarProps(props: Record<string, Scalar> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (Object.keys(props ?? {}).length > 40) throw new Error("单个 OfficeCLI 操作最多设置 40 个普通属性。");
  for (const [key, raw] of Object.entries(props ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key)) throw new Error(`无效的 OfficeCLI 属性名：${key}。`);
    const value = String(raw);
    if (value.length > 4096 || value.includes("\0")) throw new Error(`OfficeCLI 属性 ${key} 的内容无效或过长。`);
    if (FILE_KEYS.has(key.toLowerCase()) && (key.toLowerCase() !== "background" || /^image:/iu.test(value))) throw new Error(`属性 ${key} 引用本地文件时，请使用 file_properties。`);
    if (/^(?:file:|[A-Za-z]:[\\/]|\\\\|\.\.[\\/])/iu.test(value)) throw new Error(`属性 ${key} 不能直接引用工作区外的文件路径。`);
    output[key] = value;
  }
  return output;
}

async function assetProps(workspace: string, files: Record<string, string> | undefined): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  if (Object.keys(files ?? {}).length > 8) throw new Error("单个 OfficeCLI 操作最多引用 8 个素材文件。");
  for (const [key, relativePath] of Object.entries(files ?? {})) {
    if (!FILE_KEYS.has(key.toLowerCase()) || !relativePath || relativePath.length > 1024) throw new Error(`file_properties.${key} 不是允许的本地文件属性。`);
    const target = await existingFile(workspace, relativePath);
    output[key] = key.toLowerCase() === "background" ? `image:${target.file}` : target.file;
  }
  return output;
}

/** 转换为 OfficeCLI batch 的结构化项目；文件属性只接受已授权工作区内的文件。 */
export async function prepareEditCommands(workspace: string, commands: EditCommand[]): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (const item of commands) {
    const operation: Record<string, unknown> = { command: item.command };
    if (item.command === "set") {
      operation.path = domPath(item.path, "path", true);
      const props = { ...scalarProps(item.props), ...await assetProps(workspace, item.file_properties) };
      if (Object.keys(props).length === 0) throw new Error("set 至少需要一个 props 或 file_properties 属性。");
      operation.props = props;
    } else if (item.command === "add") {
      operation.parent = domPath(item.parent, "parent", true);
      if (Boolean(item.type) === Boolean(item.from)) throw new Error("add 必须且只能提供 type 或 from。");
      if (item.type) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(item.type)) throw new Error("add.type 无效。");
        operation.type = item.type;
      }
      if (item.from) operation.from = domPath(item.from, "from", true);
      const props = { ...scalarProps(item.props), ...await assetProps(workspace, item.file_properties) };
      if (Object.keys(props).length > 0) operation.props = props;
      const anchors = [item.index, item.after, item.before].filter((value) => value !== undefined);
      if (anchors.length > 1) throw new Error("add 的 index、after、before 只能选一个。");
      if (item.index !== undefined) operation.index = item.index;
      if (item.after) operation.after = domPath(item.after, "after", true);
      if (item.before) operation.before = domPath(item.before, "before", true);
    } else if (item.command === "remove") {
      operation.path = domPath(item.path, "path", true);
    } else if (item.command === "move") {
      operation.path = domPath(item.path, "path", true);
      if (!item.to && !item.after && !item.before) throw new Error("move 至少需要 to、after 或 before。");
      if (item.after && item.before) throw new Error("move 的 after 和 before 只能选一个。");
      if (item.to) operation.to = domPath(item.to, "to", true);
      if (item.after) operation.after = domPath(item.after, "after", true);
      if (item.before) operation.before = domPath(item.before, "before", true);
      if (item.index !== undefined) operation.index = item.index;
    } else {
      operation.path = domPath(item.path, "path", true);
      operation.path2 = domPath(item.path2, "path2", true);
    }
    result.push(operation);
  }
  return result;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** OfficeCLI 将较大的批次回执放在自己的临时目录；取回后直接返回给远端。 */
export async function hydrateBatchReceipt(result: unknown): Promise<unknown> {
  if (!result || typeof result !== "object") return result;
  const envelope = result as Record<string, unknown>;
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : envelope;
  const outputFile = data.outputFile;
  if (typeof outputFile !== "string") return result;
  if (!/^officecli_batch_[A-Za-z0-9_-]+[.]json$/u.test(path.basename(outputFile))) throw new Error("OfficeCLI 批次回执路径无效。");
  const temporary = await realpath(os.tmpdir());
  const file = await realpath(outputFile);
  if (!inside(temporary, file) || (await stat(file)).size > 1024 * 1024) throw new Error("OfficeCLI 批次回执不在受控临时目录内或超过 1 MiB。");
  const receipt = JSON.parse(await readFile(file, "utf8")) as unknown;
  await unlink(file);
  return data === envelope ? receipt : { ...envelope, data: receipt };
}
