import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const installCommand = "pnpm runtime:install";

async function manifestFor(projectRoot) {
  return JSON.parse(await readFile(path.join(projectRoot, "runtime", "cloudflared.json"), "utf8"));
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function binaryPath(projectRoot, version) {
  return path.join(projectRoot, ".local-tools", "cloudflared", version, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function installedVersion(binary) {
  return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim();
}

async function assertInsideProject(projectRoot, target) {
  const relative = path.relative(await realpath(projectRoot), await realpath(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("cloudflared 安装目录必须位于当前项目内。");
}

export async function cloudflaredStatus(projectRoot) {
  const manifest = await manifestFor(projectRoot);
  const asset = manifest.assets[platformKey()];
  if (!asset) return { state: "unsupported", version: manifest.version, message: `cloudflared 不支持当前平台：${platformKey()}。`, install_command: installCommand };
  const binary = binaryPath(projectRoot, manifest.version);
  let info;
  try { info = await lstat(binary); }
  catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", version: manifest.version, binary, message: "cloudflared 未安装在当前项目中。", install_command: installCommand };
    return { state: "invalid", version: manifest.version, binary, message: `无法检查 cloudflared：${error instanceof Error ? error.message : String(error)}`, install_command: installCommand };
  }
  if (!info.isFile()) return { state: "invalid", version: manifest.version, binary, message: "cloudflared 安装目标不是普通文件。", install_command: installCommand };
  try {
    await assertInsideProject(projectRoot, binary);
    if (asset.format === "binary" && await digest(binary) !== asset.sha256) throw new Error("cloudflared 二进制文件的 SHA-256 与固定发行版不符。");
    const version = installedVersion(binary);
    if (!version.includes(manifest.version)) throw new Error(`cloudflared 版本不符：${version}。`);
    return { state: "ready", version: manifest.version, binary };
  } catch (error) {
    return { state: "invalid", version: manifest.version, binary, message: error instanceof Error ? error.message : String(error), install_command: installCommand };
  }
}

export async function installCloudflared(projectRoot) {
  const manifest = await manifestFor(projectRoot);
  const asset = manifest.assets[platformKey()];
  if (!asset) throw new Error(`cloudflared 不支持当前平台：${platformKey()}。`);
  const directory = path.dirname(binaryPath(projectRoot, manifest.version));
  const binary = binaryPath(projectRoot, manifest.version);
  await mkdir(directory, { recursive: true });
  await assertInsideProject(projectRoot, directory);
  const status = await cloudflaredStatus(projectRoot);
  if (status.state === "ready") {
    console.error(`[chatgpt-mcp] cloudflared ${manifest.version} 已安装：${binary}`);
    return;
  }

  const url = `${manifest.release}/${asset.name}`;
  const temporary = path.join(directory, `.cloudflared-${randomUUID()}.download`);
  const extraction = path.join(directory, `.cloudflared-${randomUUID()}.extract`);
  console.error(`[chatgpt-mcp] 下载 cloudflared ${manifest.version}：${url}`);
  let file;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`下载 cloudflared 失败：HTTP ${response.status}。`);
    file = await open(temporary, "wx", 0o755);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024 * 1024) throw new Error("cloudflared 下载文件超过 64 MiB 限制。");
      hash.update(bytes);
      await file.writeFile(bytes);
    }
    await file.close();
    file = undefined;
    const actual = hash.digest("hex");
    if (actual !== asset.sha256) throw new Error(`cloudflared 下载校验失败：预期 ${asset.sha256}，实际 ${actual}。`);

    let installed = temporary;
    if (asset.format === "tgz") {
      await mkdir(extraction);
      execFileSync("tar", ["-xzf", temporary, "-C", extraction, "cloudflared"], { windowsHide: true });
      installed = path.join(extraction, "cloudflared");
    }
    if (process.platform !== "win32") await chmod(installed, 0o755);
    await rm(binary, { force: true });
    await rename(installed, binary);
    const version = installedVersion(binary);
    if (!version.includes(manifest.version)) throw new Error(`cloudflared 版本不符：${version}。`);
    console.error(`[chatgpt-mcp] cloudflared ${manifest.version} 已安装到项目：${binary}`);
  } catch (error) {
    await file?.close().catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true });
    await rm(extraction, { recursive: true, force: true });
  }
}
