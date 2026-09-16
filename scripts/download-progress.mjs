const MIB = 1024 * 1024;

function sizeLabel(bytes) {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** 为流式下载输出紧凑进度；交互终端单行刷新，非交互环境每 10% 或 5 MiB 输出一次。 */
export function createDownloadProgress(name, contentLength) {
  const parsed = Number(contentLength);
  const total = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  let downloaded = 0;
  let lastStep = -1;
  let lastWidth = 0;
  let lineOpen = false;

  const message = () => total
    ? `[chatgpt-mcp] 下载 ${name}：${Math.min(100, Math.floor(downloaded / total * 100))}%（${sizeLabel(downloaded)} / ${sizeLabel(total)}）`
    : `[chatgpt-mcp] 下载 ${name}：${sizeLabel(downloaded)}`;

  const render = (finished = false) => {
    const text = message();
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${text.padEnd(lastWidth)}`);
      lastWidth = Math.max(lastWidth, text.length);
      lineOpen = true;
      if (finished) { process.stderr.write("\n"); lineOpen = false; }
      return;
    }
    const step = total ? Math.floor(downloaded / total * 10) : Math.floor(downloaded / (5 * MIB));
    if (finished || step > lastStep) { console.error(text); lastStep = step; }
  };

  return {
    update(bytes) { downloaded += bytes; render(); },
    finish() { render(true); },
    abort() { if (lineOpen) { process.stderr.write("\n"); lineOpen = false; } },
  };
}
