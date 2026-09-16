import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { configPath, projectRoot } from "../../config.ts";

type Asset = { name: string; sha256: string };
type Manifest = { version: string; release: string; assets: Record<string, Asset> };
const manifest = JSON.parse(readFileSync(path.join(projectRoot, "plugins", "officecli.json"), "utf8")) as Manifest;
const installCommand = `pnpm plugins:install -- --config "${configPath}"`;
let readyCache: { binary: string; size: number; mtimeMs: number } | undefined;

function platformKey(): string {
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  if (glibc) return `linux-${process.arch}`;
  let ldd = "";
  try { ldd = execFileSync("ldd", ["--version"], { encoding: "utf8" }); }
  catch (error) { ldd = String((error as { stdout?: unknown }).stdout ?? "") + String((error as { stderr?: unknown }).stderr ?? ""); }
  return `linux${existsSync("/etc/alpine-release") || /musl/i.test(ldd) ? "-alpine" : ""}-${process.arch}`;
}

function binaryPath(): string {
  return path.join(projectRoot, ".local-tools", "officecli", manifest.version, process.platform === "win32" ? "officecli.exe" : "officecli");
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function execute(binary: string, argv: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { cwd, shell: false, windowsHide: true, env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: "1" }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => child.kill(), 60_000);
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value ?? "");
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { child.kill(); finish(new Error("OfficeCLI 输出超过 1 MiB 限制。")); return; }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect(output));
    child.stderr?.on("data", collect(errors));
    if (input !== undefined) { child.stdin?.on("error", () => undefined); child.stdin?.end(input); }
    child.once("error", (error) => finish(new Error(`无法运行项目内 OfficeCLI：${error.message}`)));
    child.once("close", (code, signal) => {
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      const stdout = Buffer.concat(output).toString("utf8").trim();
      if (signal) finish(new Error(`OfficeCLI 运行中断：${signal}。${stderr}`));
      else if (code !== 0) finish(new Error(`OfficeCLI 运行失败（${code}）：${stdout || stderr}${stdout && stderr ? `；${stderr}` : ""}`));
      else finish(undefined, stdout);
    });
  });
}

export type OfficeCliStatus = { state: "disabled" | "missing" | "invalid" | "unsupported" | "ready"; version: string; binary?: string; message?: string; install_command?: string };

/** 仅检查项目内固定版本的二进制文件，不回退到系统 PATH。 */
export async function officeCliStatus(enabled: boolean): Promise<OfficeCliStatus> {
  if (!enabled) return { state: "disabled", version: manifest.version };
  const key = platformKey();
  const asset = manifest.assets[key];
  if (!asset) return { state: "unsupported", version: manifest.version, message: `OfficeCLI 不支持当前平台：${key}。` };
  const binary = binaryPath();
  let info;
  try { info = await lstat(binary); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", version: manifest.version, binary, message: "OfficeCLI 未安装在当前项目中。", install_command: installCommand };
    return { state: "invalid", version: manifest.version, binary, message: `无法检查 OfficeCLI：${error instanceof Error ? error.message : String(error)}`, install_command: installCommand };
  }
  if (!info.isFile()) return { state: "invalid", version: manifest.version, binary, message: "OfficeCLI 安装目标不是普通文件。", install_command: installCommand };
  try {
    const relative = path.relative(await realpath(projectRoot), await realpath(binary));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { state: "invalid", version: manifest.version, binary, message: "OfficeCLI 安装目标不在当前项目内。", install_command: installCommand };
  } catch (error) {
    return { state: "invalid", version: manifest.version, binary, message: `无法检查 OfficeCLI 安装路径：${error instanceof Error ? error.message : String(error)}`, install_command: installCommand };
  }
  if (readyCache?.binary === binary && readyCache.size === info.size && readyCache.mtimeMs === info.mtimeMs) return { state: "ready", version: manifest.version, binary };
  try {
    if (await sha256(binary) !== asset.sha256) throw new Error("OfficeCLI 二进制文件的 SHA-256 与固定发行版不符。");
    const version = await execute(binary, ["--version"], projectRoot);
    if (!version.includes(manifest.version)) throw new Error(`OfficeCLI 版本不符：${version}。`);
    readyCache = { binary, size: info.size, mtimeMs: info.mtimeMs };
    return { state: "ready", version: manifest.version, binary };
  } catch (error) {
    return { state: "invalid", version: manifest.version, binary, message: error instanceof Error ? error.message : String(error), install_command: installCommand };
  }
}

export async function runOfficeCli(argv: string[], cwd: string, input?: string): Promise<unknown> {
  const status = await officeCliStatus(true);
  if (status.state !== "ready" || !status.binary) throw new Error(`${status.message ?? "OfficeCLI 不可用。"} 请在项目目录运行 ${status.install_command ?? installCommand}；安装后重新启动服务。`);
  if (input && Buffer.byteLength(input, "utf8") > 1024 * 1024) throw new Error("OfficeCLI 标准输入超过 1 MiB 限制。");
  const output = await execute(status.binary, argv, cwd, input);
  if (!output) return { ok: true };
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; }
  catch { return { output }; }
  if (parsed && typeof parsed === "object" && "success" in parsed && parsed.success === false) {
    const details = "error" in parsed ? parsed.error : undefined;
    throw new Error(`OfficeCLI 返回失败：${JSON.stringify(details ?? parsed)}`);
  }
  return parsed;
}
