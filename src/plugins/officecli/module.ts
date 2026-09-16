import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { projectRoot } from "../../config.ts";
import { readMedia } from "../../tools/files/binary.ts";
import { existingFile, writableFile } from "../../tools/files/workspace.ts";
import { failure, success } from "../../tools/shared.ts";
import { withOfficeWriteLock } from "./operations.ts";
import { runOfficeCli } from "./runtime.ts";

export const OFFICECLI_READ_TOOL_NAMES = ["office_skill", "office_view", "office_get", "office_query", "office_validate"] as const;
export const OFFICECLI_WRITE_TOOL_NAMES = ["office_screenshot", "office_create", "office_add_element", "office_set_cell", "office_replace_text"] as const;

function officeExtension(file: string): void {
  if (!/[.]((docx)|(xlsx)|(pptx))$/iu.test(file)) throw new Error("OfficeCLI 仅接受 .docx、.xlsx 或 .pptx 文件。");
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 只向 ChatGPT 开放参数明确、路径受工作区约束的 OfficeCLI 操作。 */
export function registerOfficeCliTools(server: McpServer, writesEnabled: boolean, enabled: boolean): void {
  if (!enabled) return;
  server.registerTool("office_skill", { title: "读取 OfficeCLI 专项说明", description: "读取 OfficeCLI 内置的 Word、Excel 或 PowerPoint 文档操作指南。", inputSchema: { name: z.enum(["word", "excel", "pptx", "word-form", "morph-ppt", "morph-ppt-3d", "pitch-deck", "academic-paper", "data-dashboard", "financial-model"]) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ name }) => {
    try { return success(await runOfficeCli(["load_skill", name], projectRoot)); }
    catch (error) { return failure(error); }
  });
  server.registerTool("office_view", { title: "查看 Office 文档", description: "读取授权工作区中的 Office 文档，支持文本、结构、问题、HTML 与 SVG 等模式，并返回文件 SHA-256。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), mode: z.enum(["text", "annotated", "outline", "stats", "issues", "forms", "html", "svg"]).default("text"), max_lines: z.number().int().min(1).max(1000).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path: relativePath, mode, max_lines }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      officeExtension(target.file);
      const args = ["view", target.file, mode, "--json"];
      if (max_lines) args.push("--max-lines", String(max_lines));
      const data = await runOfficeCli(args, target.workspace);
      return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), sha256: await sha256(target.file), result: data });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_get", { title: "读取 Office 文档节点", description: "按 DOM 路径读取授权 Office 文档中的节点。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), node_path: z.string().startsWith("/").max(1024).default("/"), depth: z.number().int().min(0).max(5).default(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path: relativePath, node_path, depth }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      officeExtension(target.file);
      return success(await runOfficeCli(["get", target.file, node_path, "--depth", String(depth), "--json"], target.workspace));
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_query", { title: "查询 Office 文档元素", description: "使用 OfficeCLI 选择器查询授权文档。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), selector: z.string().min(1).max(1024) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path: relativePath, selector }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      officeExtension(target.file);
      return success(await runOfficeCli(["query", target.file, selector, "--json"], target.workspace));
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_validate", { title: "校验 Office 文档", description: "检查授权 Office 文档的 OpenXML 结构。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ workspace, path: relativePath }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      officeExtension(target.file);
      return success(await runOfficeCli(["validate", target.file, "--json"], target.workspace));
    } catch (error) { return failure(error); }
  });
  if (writesEnabled) server.registerTool("office_screenshot", { title: "生成并查看 Office 文档截图", description: "将授权文档渲染到工作区中的新 PNG 文件，并把图片内容直接返回给 ChatGPT。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), output_path: z.string().min(1), page: z.string().regex(/^[1-9]\d*(?:-[1-9]\d*)?$/u).optional() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async ({ workspace, path: relativePath, output_path, page }) => {
    try {
      const source = await existingFile(workspace, relativePath);
      officeExtension(source.file);
      if (!/[.]png$/iu.test(output_path)) throw new Error("output_path 必须以 .png 结尾。");
      const output = await writableFile(workspace, output_path, false);
      if (output.exists) throw new Error("截图目标已存在，请选择新的 output_path。");
      const args = ["view", source.file, "screenshot", "--out", output.file, "--render", "html", "--json"];
      if (page) args.push("--page", page);
      return await withOfficeWriteLock(output.file, async () => {
        if ((await writableFile(workspace, output_path, false)).exists) throw new Error("截图目标已存在，请选择新的 output_path。");
        await runOfficeCli(args, source.workspace);
        return await readMedia(output.workspace, path.relative(output.workspace, output.file));
      });
    } catch (error) { return failure(error); }
  });
  if (!writesEnabled) return;
  server.registerTool("office_create", { title: "创建 Office 文档", description: "在授权工作区中创建新的空白 .docx、.xlsx 或 .pptx 文件；拒绝覆盖。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u).optional() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async ({ workspace, path: relativePath, locale }) => {
    try {
      officeExtension(relativePath);
      const target = await writableFile(workspace, relativePath, false);
      if (target.exists) throw new Error("目标文件已存在，请选择新路径。");
      const args = ["create", target.file, "--json"];
      if (locale) args.push("--locale", locale);
      return await withOfficeWriteLock(target.file, async () => {
        if ((await writableFile(workspace, relativePath, false)).exists) throw new Error("目标文件已存在，请选择新路径。");
        const result = await runOfficeCli(args, target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), created: true, sha256: await sha256(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_add_element", { title: "向 Office 文档添加元素", description: "给 Word 添加段落、文本或表格，或给 PowerPoint 添加幻灯片或文字形状；必须提供最新文档 SHA-256。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), parent_path: z.string().startsWith("/").max(1024), type: z.enum(["paragraph", "run", "table", "slide", "shape"]), text: z.string().max(4096).optional(), rows: z.number().int().min(1).max(100).optional(), cols: z.number().int().min(1).max(50).optional(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, parent_path, type, text, rows, cols, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      officeExtension(target.file);
      const extension = path.extname(target.file).toLowerCase();
      if ((extension === ".docx" && !["paragraph", "run", "table"].includes(type)) || (extension === ".pptx" && !["slide", "shape", "run"].includes(type)) || extension === ".xlsx") throw new Error("该元素类型不适用于当前文档；Excel 单元格请使用 office_set_cell。");
      if (["paragraph", "run", "shape"].includes(type) && text === undefined) throw new Error("此元素需要 text 内容。");
      if (type === "table" && (!rows || !cols)) throw new Error("添加表格时必须提供 rows 和 cols。");
      if ((type === "table" || type === "slide") && text !== undefined || type !== "table" && (rows !== undefined || cols !== undefined)) throw new Error("text、rows、cols 参数与元素类型不匹配。");
      const args = ["add", target.file, parent_path, "--type", type];
      if (text !== undefined) args.push("--prop", `text=${text}`);
      if (rows) args.push("--prop", `rows=${rows}`);
      if (cols) args.push("--prop", `cols=${cols}`);
      if (type === "slide") args.push("--prop", "layout=blank");
      args.push("--json");
      return await withOfficeWriteLock(target.file, async () => {
        if (await sha256(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再编辑。");
        const result = await runOfficeCli(args, target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await sha256(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_set_cell", { title: "设置 Excel 单元格", description: "给授权 .xlsx 文档中的指定单元格设置值；必须提供最新文档 SHA-256。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), sheet: z.string().min(1).max(31).regex(/^[^\\/\[\]*?:\x00-\x1f]+$/u), cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/u), value: z.string().max(4096), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, sheet, cell, value, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      if (path.extname(target.file).toLowerCase() !== ".xlsx") throw new Error("office_set_cell 只接受 .xlsx 文档。");
      return await withOfficeWriteLock(target.file, async () => {
        if (await sha256(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再编辑。");
        const result = await runOfficeCli(["set", target.file, `/${sheet}/${cell}`, "--prop", `value=${value}`, "--json"], target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await sha256(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
  server.registerTool("office_replace_text", { title: "替换 Office 文档文字", description: "在指定 DOM 节点替换文字；必须提交 office_view 返回的最新 SHA-256。", inputSchema: { workspace: z.string().min(1), path: z.string().min(1), node_path: z.string().startsWith("/").max(1024), find: z.string().min(1).max(4096), replace: z.string().max(4096), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async ({ workspace, path: relativePath, node_path, find, replace, expected_sha256 }) => {
    try {
      const target = await existingFile(workspace, relativePath);
      officeExtension(target.file);
      if (path.extname(target.file).toLowerCase() === ".xlsx") throw new Error("Excel 单元格请使用 office_set_cell。");
      return await withOfficeWriteLock(target.file, async () => {
        if (await sha256(target.file) !== expected_sha256) throw new Error("文档内容已变化，请重新调用 office_view 后再编辑。");
        const result = await runOfficeCli(["set", target.file, node_path, "--find", find, "--replace", replace, "--json"], target.workspace);
        return success({ workspace: target.workspace, path: path.relative(target.workspace, target.file), updated: true, sha256: await sha256(target.file), result });
      });
    } catch (error) { return failure(error); }
  });
}
