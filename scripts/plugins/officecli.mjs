import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

function platformKey() {
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  if (glibc) return `linux-${process.arch}`;
  let ldd = "";
  try { ldd = execFileSync("ldd", ["--version"], { encoding: "utf8" }); }
  catch (error) { ldd = String(error?.stdout ?? "") + String(error?.stderr ?? ""); }
  return `linux${existsSync("/etc/alpine-release") || /musl/i.test(ldd) ? "-alpine" : ""}-${process.arch}`;
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function installOfficeCli(projectRoot) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "plugins", "officecli.json"), "utf8"));
  const key = platformKey();
  const asset = manifest.assets[key];
  if (!asset) throw new Error(`OfficeCLI 不支持当前平台：${key}。`);
  const directory = path.join(projectRoot, ".local-tools", "officecli", manifest.version);
  const binary = path.join(directory, process.platform === "win32" ? "officecli.exe" : "officecli");
  await mkdir(directory, { recursive: true });
  const relative = path.relative(await realpath(projectRoot), await realpath(directory));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("OfficeCLI 安装目录必须位于当前项目内。");
  let existing;
  try { existing = await lstat(binary); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing && !existing.isFile()) throw new Error(`OfficeCLI 安装目标不是普通文件：${binary}`);
  if (existing && await digest(binary) === asset.sha256) {
    console.error(`[chatgpt-mcp] OfficeCLI ${manifest.version} 已安装：${binary}`);
    return;
  }

  const url = `${manifest.release}/${asset.name}`;
  console.error(`[chatgpt-mcp] 下载 OfficeCLI ${manifest.version}：${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`下载 OfficeCLI 失败：HTTP ${response.status}。`);
  const temporary = path.join(directory, `.officecli-${randomUUID()}.download`);
  let file;
  try {
    file = await open(temporary, "wx", 0o755);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024 * 1024) throw new Error("OfficeCLI 下载文件超过 64 MiB 限制。");
      hash.update(bytes);
      await file.writeFile(bytes);
    }
    await file.close();
    file = undefined;
    const actual = hash.digest("hex");
    if (actual !== asset.sha256) throw new Error(`OfficeCLI 下载校验失败：预期 ${asset.sha256}，实际 ${actual}。`);
    if (process.platform !== "win32") await chmod(temporary, 0o755);
    if (existing) await rm(binary);
    await rename(temporary, binary);
    console.error(`[chatgpt-mcp] OfficeCLI ${manifest.version} 已安装到项目：${binary}`);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}
