import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

/**
 * 安全解压（升级任务书 §3.3）：
 * - ZIP Slip：entryName 规范化后必须仍在解压目录内，拒绝绝对路径 / ../ 盘符
 * - 压缩炸弹：解压后总大小 / 文件数 / 单文件大小 / 压缩比上限
 * - 恶意文件名：Windows 保留名与控制字符拒绝
 * - 失败回滚：先解压到临时目录，成功后原子改名为目标目录
 */

export interface SafeExtractLimits {
  maxTotalBytes?: number;   // 解压后总大小上限（默认 2GB）
  maxFiles?: number;        // 文件数上限（默认 50000）
  maxFileBytes?: number;    // 单文件上限（默认 512MB）
  maxRatio?: number;        // 压缩比上限（默认 200，防炸弹）
  timeoutMs?: number;       // 超时（默认 120s）
}

const DEFAULTS: Required<SafeExtractLimits> = {
  maxTotalBytes: 2 * 1024 ** 3,
  maxFiles: 50_000,
  maxFileBytes: 512 * 1024 ** 2,
  maxRatio: 200,
  timeoutMs: 120_000,
};

/** Windows 保留设备名 */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

function assertSafeEntryName(entryName: string): void {
  const norm = path.normalize(entryName).replace(/\\/g, '/');
  if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new Error(`压缩包包含绝对路径条目：${entryName}`);
  if (norm.split('/').includes('..')) throw new Error(`压缩包包含路径穿越条目：${entryName}`);
  if (norm.includes('\0')) throw new Error('压缩包文件名含空字节');
  for (const seg of norm.split('/')) {
    if (RESERVED.test(seg)) throw new Error(`压缩包包含 Windows 保留文件名：${seg}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>:"|?*]/.test(seg)) throw new Error(`压缩包包含非法文件名字符：${seg}`);
  }
}

export interface SafeExtractResult {
  dir: string;
  files: number;
  totalBytes: number;
}

/**
 * 安全解压 ZIP。返回实际解压目录（失败时抛错并清理临时目录）。
 */
export function safeExtractZip(archivePath: string, destDir: string, limits?: SafeExtractLimits): SafeExtractResult {
  const lim = { ...DEFAULTS, ...limits };
  const started = Date.now();
  const tmpDir = `${destDir}.tmp-${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const realDestRoot = fs.realpathSync(tmpDir);

  try {
    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();
    if (entries.length > lim.maxFiles) throw new Error(`压缩包条目数 ${entries.length} 超过上限 ${lim.maxFiles}（疑似压缩炸弹）`);

    let totalUncompressed = 0;
    let totalCompressed = 0;
    let fileCount = 0;

    for (const entry of entries) {
      if (Date.now() - started > lim.timeoutMs) throw new Error(`解压超时（>${lim.timeoutMs}ms），已中止`);
      const entryName = entry.entryName;
      if (entry.isDirectory) continue;
      assertSafeEntryName(entryName);

      const header = entry.header;
      const uncompressed = Number(header.size);
      const compressed = Math.max(Number(header.compressedSize), 1);
      if (uncompressed > lim.maxFileBytes) throw new Error(`单文件 ${entryName} 解压后 ${uncompressed}B 超过上限 ${lim.maxFileBytes}B`);
      totalUncompressed += uncompressed;
      totalCompressed += compressed;
      if (totalUncompressed > lim.maxTotalBytes) throw new Error(`解压总量 ${totalUncompressed}B 超过上限 ${lim.maxTotalBytes}B（疑似压缩炸弹）`);
      // 压缩比炸弹判定：对 >64KB 的文件，解压后与压缩前比率超限即拒绝（小文件比率无意义）
      if (uncompressed > 64 * 1024 && uncompressed / compressed > lim.maxRatio) {
        throw new Error(`压缩比 ${Math.round(uncompressed / compressed)}:1 异常（疑似压缩炸弹）：${entryName}`);
      }

      const target = path.join(realDestRoot, entryName);
      const rel = path.relative(realDestRoot, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`条目越界：${entryName}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 符号链接逃逸防护：目录链上的 symlink 一律拒绝
      let probe = path.dirname(target);
      while (probe.startsWith(realDestRoot) && probe !== realDestRoot) {
        const st = fs.lstatSync(probe, { throwIfNoEntry: false });
        if (st && st.isSymbolicLink()) throw new Error(`解压路径含符号链接，拒绝写入：${probe}`);
        probe = path.dirname(probe);
      }
      const data = entry.getData();
      fs.writeFileSync(target, data);
      fileCount++;
    }

    // 目标目录若已存在则报错（由调用方保证唯一），成功后原子改名
    if (fs.existsSync(destDir)) throw new Error(`目标目录已存在：${destDir}`);
    fs.renameSync(tmpDir, destDir);
    return { dir: destDir, files: fileCount, totalBytes: totalUncompressed };
  } catch (err) {
    // 失败清理临时目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 通过系统工具解压 7z/RAR（诚实支持：工具存在才支持，不存在给出明确安装指引）。
 * 提取后运行与 zip 相同的越界/残留校验。
 */
export function safeExtractWithSystemTool(archivePath: string, destDir: string, limits?: SafeExtractLimits): SafeExtractResult {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const lim = { ...DEFAULTS, ...limits };
  const tmpDir = `${destDir}.tmp-${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  // 工具探测：优先 7z（同时支持 7z 与 rar），其次 WinRAR
  const candidates: Array<{ cmd: string; args: (a: string, d: string) => string[]; kind: string; install: string }> = [
    { cmd: '7z.exe', args: (a, d) => ['x', '-y', `-o${d}`, a], kind: '7z', install: 'https://www.7-zip.org/ 安装 7-Zip 后重试' },
    { cmd: 'rar.exe', args: (a, d) => ['x', '-y', a, `${d}\\`], kind: 'rar', install: 'https://www.win-rar.com/ 安装 WinRAR 后重试' },
    { cmd: 'unrar.exe', args: (a, d) => ['x', '-y', a, `${d}\\`], kind: 'rar', install: '安装 unrar 工具后重试' },
  ];
  const isWin = process.platform === 'win32';
  let chosen: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    try {
      execFileSync(isWin ? 'where' : 'which', [c.cmd], { stdio: 'pipe' });
      chosen = c;
      break;
    } catch { /* 未安装，试下一个 */ }
  }
  if (!chosen) throw new Error(`系统缺少 ${path.extname(archivePath)} 解压工具。请${candidates[0].install}（DevPilot 不静默安装系统软件）`);

  try {
    const started = Date.now();
    execFileSync(chosen.cmd, chosen.args(archivePath, tmpDir), { stdio: 'pipe', timeout: lim.timeoutMs, windowsHide: true });

    // 解压完成后逐文件校验：越界（工具自身应防，但双保险）、总量、文件数
    const realRoot = fs.realpathSync(tmpDir);
    let files = 0;
    let totalBytes = 0;
    const walk = (dir: string) => {
      if (Date.now() - started > lim.timeoutMs) throw new Error('解压超时，已中止');
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.isSymbolicLink()) throw new Error(`压缩包含符号链接，已拒绝：${full}`);
        const st = fs.statSync(full);
        totalBytes += st.size;
        if (totalBytes > lim.maxTotalBytes) throw new Error(`解压总量超上限（疑似压缩炸弹）`);
        files++;
        if (files > lim.maxFiles) throw new Error(`解压文件数超上限（疑似压缩炸弹）`);
        const rel = path.relative(realRoot, full);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`条目越界：${rel}`);
      }
    };
    walk(realRoot);
    if (fs.existsSync(destDir)) throw new Error(`目标目录已存在：${destDir}`);
    fs.renameSync(tmpDir, destDir);
    return { dir: destDir, files, totalBytes };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (err instanceof Error && /ENOENT|not recognized/i.test(err.message)) {
      throw new Error(`系统缺少 ${path.extname(archivePath)} 解压工具。请${candidates[0].install}`);
    }
    throw err;
  }
}

/** 统一入口：按扩展名分发 */
export function safeExtractArchive(archivePath: string, destDir: string, limits?: SafeExtractLimits): SafeExtractResult {
  if (!fs.existsSync(archivePath)) throw new Error(`压缩包不存在：${archivePath}`);
  const st = fs.statSync(archivePath);
  if (st.size > 1024 * 1024 * 1024) throw new Error('压缩包体积超过 1GB 上限，拒绝导入');
  if (/\.zip$/i.test(archivePath)) return safeExtractZip(archivePath, destDir, limits);
  if (/\.(7z|rar)$/i.test(archivePath)) return safeExtractWithSystemTool(archivePath, destDir, limits);
  throw new Error(`不支持的压缩格式：${path.extname(archivePath)}（支持 .zip/.7z/.rar）`);
}
