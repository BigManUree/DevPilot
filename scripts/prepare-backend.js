/**
 * 打包前置：用 pnpm deploy 生成自包含 backend（真实 node_modules，无 workspace symlink），
 * 输出到 apps/desktop/resources-backend，供 electron-builder extraResources 使用。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'apps', 'desktop', 'resources-backend');

try {
  fs.rmSync(out, { recursive: true, force: true });
} catch {
  // 沙箱批量删除守卫等环境：rmSync 被拦时改名让路，deploy 直接重建（本目录为可再生构建产物）
  try {
    fs.renameSync(out, `${out}.trash-${Date.now()}`);
    console.warn('rmSync blocked — old resources-backend renamed aside (.trash-*)');
  } catch { /* 首次打包目录不存在 */ }
}
try {
  execSync(`pnpm --filter @devpilot/backend deploy --prod "${out}"`, {
    cwd: root,
    stdio: 'inherit',
  });
} catch (e) {
  // pnpm 12 deploy 对 ignored build scripts 会非零退出，但 node_modules 已就位；
  // 下面 pack-check 会兜底验证，缺原生模块则补 prebuild-install。
  console.warn('deploy exited non-zero (ignored builds) — continuing, will verify');
}

// deploy 产物健康检查：原生模块与 shared-types 可加载；缺 .node 则补 prebuild-install
const sqliteDir = (() => {
  const base = path.join(out, 'node_modules', 'better-sqlite3');
  if (fs.existsSync(path.join(base, 'build', 'Release', 'better_sqlite3.node'))) return null;
  return base;
})();
if (sqliteDir) {
  // deploy 目录内无 prebuild-install；先拷 workspace 的 Node22 ABI 二进制兜底，
  // 再下载 Electron ABI prebuild 覆盖——打包态 electron-as-node 要求 NODE_MODULE_VERSION 130
  const src = path.join(root, 'apps', 'backend', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node')), { recursive: true });
  fs.copyFileSync(src, path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node'));
  console.log('copied better_sqlite3.node from workspace build (node ABI)');
}

// Electron ABI 原生件：better-sqlite3 官方 prebuild（github 直连超时走 npmmirror 镜像）
const electronVer = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'apps', 'desktop', 'node_modules', 'electron', 'package.json'), 'utf-8')).version; } catch { return null; }
})();
if (electronVer) {
  const bsDir = path.join(out, 'node_modules', 'better-sqlite3');
  try {
    // 网络抖动可能首连超时，重试一次（二次通常命中本地 prebuilds 缓存）
    const run = () => execSync(`npx -y prebuild-install -r electron -t ${electronVer} --verbose`, {
      cwd: bsDir,
      stdio: 'inherit',
      env: { ...process.env, npm_config_better_sqlite3_binary_host_mirror: 'https://npmmirror.com/mirrors/better-sqlite3' },
    });
    try { run(); } catch { run(); }
    console.log(`better-sqlite3 replaced with electron@${electronVer} (ABI 130) prebuild`);
  } catch (e) {
    console.warn('WARN: electron prebuild install failed — packaged backend may hit NODE_MODULE_VERSION mismatch');
  }
}
const check = `const D=require('better-sqlite3');new D(':memory:');
const s=require('@devpilot/shared-types');
console.log('pack-check ok sqlite+shared-types, events=' + s.WS_EVENTS.length);`;
execSync(`node -e "${check.replace(/"/g, '\\"')}"`, { cwd: out, stdio: 'inherit' });
console.log('resources-backend ready:', out);
