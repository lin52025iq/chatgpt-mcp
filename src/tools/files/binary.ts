import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { successContent } from "../shared.ts";
import { existingFile, writableFile } from "./workspace.ts";

const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

type ChatGptFile = { download_url: string; file_id: string; mime_type?: string; file_name?: string };

function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

function mediaType(data: Buffer): { type: "image" | "audio"; mimeType: string } | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { type: "image", mimeType: "image/png" };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { type: "image", mimeType: "image/jpeg" };
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return { type: "image", mimeType: "image/webp" };
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE") return { type: "audio", mimeType: "audio/wav" };
  if (data.toString("ascii", 0, 3) === "ID3" || data[0] === 0xff && (data[1]! & 0xe0) === 0xe0) return { type: "audio", mimeType: "audio/mpeg" };
  return undefined;
}

/** 将授权工作区中的图片或音频以 MCP 媒体内容返回。 */
export async function readMedia(workspaceInput: string, relativePath: string): Promise<CallToolResult> {
  const target = await existingFile(workspaceInput, relativePath);
  const size = (await stat(target.file)).size;
  if (size > MAX_MEDIA_BYTES) throw new Error("媒体文件超过 4 MiB 限制。");
  const data = await readFile(target.file);
  const media = mediaType(data);
  if (!media) throw new Error("目前仅支持 PNG、JPEG、WebP、WAV 和 MP3 媒体文件。");
  const info = { workspace: target.workspace, path: path.relative(target.workspace, target.file), mime_type: media.mimeType, size: data.length, sha256: sha256(data) };
  return successContent([{ type: "text", text: JSON.stringify(info) }, { type: media.type, data: data.toString("base64"), mimeType: media.mimeType }]);
}

/** 从严格的 Base64 输入创建二进制文件，拒绝覆盖已有文件。 */
export async function createBinaryFile(workspaceInput: string, relativePath: string, base64: string) {
  if (base64.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) throw new Error("data_base64 必须是有效且不超过 1 MiB 的 Base64 内容。");
  const data = Buffer.from(base64, "base64");
  if (data.length > MAX_INLINE_BYTES || data.toString("base64") !== base64) throw new Error("data_base64 必须是有效且不超过 1 MiB 的 Base64 内容。");
  const target = await writableFile(workspaceInput, relativePath, false);
  if (target.exists) throw new Error("目标文件已存在，请选择新路径。");
  await writeFile(target.file, data, { flag: "wx" });
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), created: true, size: data.length, sha256: sha256(data) };
}

function trustedDownloadUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const trusted = ["openai.com", "chatgpt.com", "oaiusercontent.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !trusted) throw new Error("仅接受 ChatGPT/OpenAI HTTPS 文件下载地址。");
  return url;
}

/** 从 ChatGPT 文件参数给出的临时地址下载文件并创建到授权工作区。 */
export async function importChatGptFile(workspaceInput: string, relativePath: string, file: ChatGptFile) {
  const target = await writableFile(workspaceInput, relativePath, false);
  if (target.exists) throw new Error("目标文件已存在，请选择新路径。");
  const url = trustedDownloadUrl(file.download_url);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`ChatGPT 文件下载失败：HTTP ${response.status}。`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_IMPORT_BYTES) { await response.body.cancel(); throw new Error("文件超过 16 MiB 限制。"); }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > MAX_IMPORT_BYTES) throw new Error("文件超过 16 MiB 限制。");
      chunks.push(data);
    }
  } catch (error) { await response.body.cancel().catch(() => undefined); throw error; }
  const data = Buffer.concat(chunks);
  await writeFile(target.file, data, { flag: "wx" });
  return { workspace: target.workspace, path: path.relative(target.workspace, target.file), created: true, file_id: file.file_id, size: data.length, sha256: sha256(data) };
}
