import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { projectRoot } from "../../config.ts";
import { readMedia } from "../../tools/files/binary.ts";
import { existingFile, writableFile } from "../../tools/files/workspace.ts";
import { failure, success } from "../../tools/shared.ts";
import { hydrateBatchReceipt, prepareEditCommands, withOfficeWriteLock, type EditCommand } from "./operations.ts";
import { runOfficeCli } from "./runtime.ts";

export const OFFICECLI_EXTENDED_READ_NAMES = ["office_help", "office_raw", "office_dump"] as const;
export const OFFICECLI_EXTENDED_WRITE_NAMES = ["office_edit", "office_merge", "office_import_data", "office_extract_media", "office_raw_set", "office_add_part", "office_refresh"] as const;

const domPath = z.string().startsWith("/").max(1024);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const scalar = z.union([z.string().max(4096), z.number(), z.boolean()]);
const editCommand = z.object({
  command: z.enum(["set", "add", "remove", "move", "swap"]),
  path: domPath.optional(), parent: domPath.optional(), type: z.string().min(1).max(64).optional(), from: domPath.optional(),
  to: domPath.optional(), after: domPath.optional(), before: domPath.optional(), path2: domPath.optional(),
  index: z.number().int().min(0).max(1_000_000).optional(),
  props: z.record(z.string().max(64), scalar).optional(),
  file_properties: z.record(z.string().max(64), z.string().min(1).max(1024)).optional(),
});

function extension(file: string): string {
  const result = path.extname(file).toLowerCase();
  if (![".docx", ".xlsx", ".pptx"].includes(result)) throw new Error("仅支持 .docx、.xlsx 和 .pptx 文档。");
  return result;
}

async function fileSha(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** OfficeCLI 的广域文档操作入口；原始文件路径均在调用前通过工作区校验。 */
export function registerOfficeCliExtendedTools(server: McpServer, writesEnabled: boolean, enabled: boolean): void {
  if (!enabled) return;
  server.registerTool("office_help", { title: "查询 OfficeCLI 元素和属性", description: "查询固定版本 OfficeCLI 中指定格式、操作和元素的真实属性说明。", inputSchema: { format: z.enum(["docx", "xlsx", "pptx"]), verb: z.enum(["add", "set", "get", "query", "remove"]).optional(), element: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ format, verb, element }) => {
    try {
      const args = ["help", format];
      if (verb) args.push(verb);
      if (element) args.push(element);
      return success(await runOfficeCli(args, projectRoot));
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_raw", { title: "读取 Office 文档 XML", description: "读取授权文档中指定 OpenXML 部件的原始内容。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), part: domPath.default("/document"), start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path: relativePath, part, start, end }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      extension(target.file);
      const args = ["raw", target.file, part, "--json"];
      if (start) args.push("--start", String(start));
      if (end) args.push("--end", String(end));
      return success(await runOfficeCli(args, target.workspace));
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_dump", { title: "导出 Office 文档结构", description: "把授权文档或其子树导出为 OfficeCLI 可重放的批量操作数据；大文档可指定较小的 node_path。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), node_path: domPath.default("/") }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path: relativePath, node_path }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      extension(target.file);
      return success(await runOfficeCli(["dump", target.file, node_path, "--json"], target.workspace));
    } catch (error) { return failure(error); }
  });
  if (!writesEnabled) return;
  server.registerTool("office_edit", { title: "批量编辑 Office 文档", description: "在一次原子批次中执行 set/add/remove/move/swap；支持 OfficeCLI 属性和授权工作区内的本地素材，要求最新文档 SHA-256。先用 office_help 查询属性。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), expected_sha256: sha, commands: z.array(editCommand).min(1).max(30) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, expected_sha256, commands }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      extension(target.file);
      return await withOfficeWriteLock(target.file, async () => {
        if (await fileSha(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再编辑。");
        const items = await prepareEditCommands(target.workspace, commands as EditCommand[]);
        const result = await runOfficeCli(["batch", target.file, "--json"], target.workspace, JSON.stringify(items));
        let receipt = result;
        let receiptWarning: string | undefined;
        try { receipt = await hydrateBatchReceipt(result); }
        catch (error) { receiptWarning = `批次已执行，但完整回执无法读取：${error instanceof Error ? error.message : String(error)}`; }
        const after = await fileSha(target.file);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: after !== expected_sha256, sha256: after, receipt, ...(receiptWarning ? { receipt_warning: receiptWarning } : {}) });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_merge", { title: "使用模板创建 Office 文档", description: "用 JSON 数据填充授权工作区内 Office 模板的 {{key}} 占位符，输出新的同类型文档；可传 data 或工作区内 data_path，拒绝覆盖。", inputSchema: { workspace: z.string().min(1), template_path: z.string().min(1), output_path: z.string().min(1), data: z.record(z.string().min(1).max(128), z.unknown()).optional(), data_path: z.string().min(1).optional() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async ({ workspace, template_path, output_path, data, data_path }) => {
    try {
      const template = await existingFile(workspace, template_path);
      const format = extension(template.file);
      const output = await writableFile(workspace, output_path, false);
      if (output.exists || path.extname(output.file).toLowerCase() !== format) throw new Error("输出路径须为新的同类型 Office 文档，不能覆盖现有文件。");
      if (Boolean(data) === Boolean(data_path)) throw new Error("请且仅请提供 data 或 data_path。");
      let source: string;
      if (data_path) {
        const input = await existingFile(workspace, data_path);
        if (path.extname(input.file).toLowerCase() !== ".json" || (await stat(input.file)).size > 1024 * 1024) throw new Error("模板数据文件必须是工作区内且不超过 1 MiB 的 .json 文件。");
        const parsed = JSON.parse(await readFile(input.file, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模板数据须为 JSON 对象。");
        source = input.file;
      } else {
        const json = JSON.stringify(data);
        if (Buffer.byteLength(json, "utf8") > 8_000) throw new Error("内联模板数据超过 8 KiB；请改用工作区内的 data_path。");
        source = json;
      }
      return await withOfficeWriteLock(output.file, async () => {
        if ((await writableFile(workspace, output_path, false)).exists) throw new Error("输出路径已存在，请选择新的 output_path。");
        const result = await runOfficeCli(["merge", template.file, output.file, "--data", source, "--json"], template.workspace);
        return success({ workspace: output.workspace, path: path.relative(output.workspace, output.file), created: true, sha256: await fileSha(output.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_import_data", { title: "导入 CSV 或 TSV 到 Excel", description: "将授权工作区中的 CSV/TSV 文件导入现有 .xlsx 工作表，要求最新文档 SHA-256。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), source_path: z.string().min(1), sheet_path: domPath, start_cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/u).default("A1"), header: z.boolean().default(false), expected_sha256: sha }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, source_path, sheet_path, start_cell, header, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      const source = await existingFile(workspace, source_path);
      if (extension(target.file) !== ".xlsx" || !/[.](csv|tsv)$/iu.test(source.file)) throw new Error("目标须为 .xlsx，数据源须为工作区内的 .csv 或 .tsv 文件。");
      return await withOfficeWriteLock(target.file, async () => {
        if (await fileSha(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再导入。");
        const args = ["import", target.file, sheet_path, source.file, "--start-cell", start_cell, "--json"];
        if (header) args.push("--header");
        const result = await runOfficeCli(args, target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await fileSha(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_extract_media", { title: "提取 Office 文档内的媒体", description: "按 DOM 路径把文档内图片或其他二进制载荷提取为工作区中的新文件；可显示的图片和音频直接返回媒体内容。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), node_path: domPath, output_path: z.string().min(1) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async ({ workspace, path: relativePath, node_path, output_path }) => {
    try {
      const source = await existingFile(workspace, relativePath);
      extension(source.file);
      const output = await writableFile(workspace, output_path, false);
      if (output.exists) throw new Error("媒体目标已存在，请选择新的 output_path。");
      return await withOfficeWriteLock(output.file, async () => {
        if ((await writableFile(workspace, output_path, false)).exists) throw new Error("媒体目标已存在，请选择新的 output_path。");
        const result = await runOfficeCli(["get", source.file, node_path, "--save", output.file, "--json"], source.workspace);
        const relative = path.relative(output.workspace, output.file);
        try { return await readMedia(output.workspace, relative); }
        catch { return success({ workspace: output.workspace, path: relative, size: (await stat(output.file)).size, sha256: await fileSha(output.file), result }); }
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_raw_set", { title: "修改 Office 文档 XML", description: "对授权 Office 文档的指定 OpenXML 部件执行 XPath 修改；要求最新文档 SHA-256，适用于常规 DOM 操作无法完成的内容。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), part: domPath, xpath: z.string().min(1).max(2048), action: z.enum(["append", "prepend", "insertbefore", "insertafter", "replace", "remove", "setattr"]), xml: z.string().max(8192).optional(), expected_sha256: sha }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, part, xpath, action, xml, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      extension(target.file);
      if (action !== "remove" && xml === undefined) throw new Error("此 raw-set 操作需要 xml 内容。");
      return await withOfficeWriteLock(target.file, async () => {
        if (await fileSha(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再修改 XML。");
        const args = ["raw-set", target.file, part, "--xpath", xpath, "--action", action, "--json"];
        if (xml !== undefined) args.push("--xml", xml);
        const result = await runOfficeCli(args, target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await fileSha(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_add_part", { title: "创建 Office 文档部件", description: "创建 Word 的 chart/header/footer 或 PPT/Excel 的 chart 部件，要求最新文档 SHA-256。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), parent: domPath, type: z.enum(["chart", "header", "footer"]), expected_sha256: sha }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, parent, type, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      const format = extension(target.file);
      if (format !== ".docx" && type !== "chart") throw new Error("此格式只支持创建 chart 部件。");
      return await withOfficeWriteLock(target.file, async () => {
        if (await fileSha(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再创建部件。");
        const result = await runOfficeCli(["add-part", target.file, parent, "--type", type, "--json"], target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await fileSha(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_refresh", { title: "刷新 Word 文档字段", description: "刷新 Word 文档的 TOC/PAGE/NUMPAGES 等衍生字段；此操作在 Windows 上需要安装 Word。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), expected_sha256: sha }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      if (extension(target.file) !== ".docx") throw new Error("office_refresh 仅支持 .docx。");
      return await withOfficeWriteLock(target.file, async () => {
        if (await fileSha(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再刷新字段。");
        const result = await runOfficeCli(["refresh", target.file, "--json"], target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await fileSha(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
}
