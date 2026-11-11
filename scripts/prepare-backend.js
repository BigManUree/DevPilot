/**
 * 打包前置：用 pnpm deploy 生成自包含 backend（真实 node_modules，无 workspace symlink），
 * 输出到 apps/desktop/resources-backend，供 electron-builder extraResources 使用。
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'apps', 'desktop', 'resources-backend');

fs.rmSync(out, { recursive: true, force: true });
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
  // deploy 目录内无 prebuild-install；从 workspace 已构建的 better-sqlite3 拷原生二进制（同版本同 ABI）
  const src = path.join(root, 'apps', 'backend', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node')), { recursive: true });
  fs.copyFileSync(src, path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node'));
  console.log('copied better_sqlite3.node from workspace build');
}
const check = `const D=require('better-sqlite3');new D(':memory:');
const s=require('@devpilot/shared-types');
console.log('pack-check ok sqlite+shared-types, events=' + s.WS_EVENTS.length);`;
execSync(`node -e "${check.replace(/"/g, '\\"')}"`, { cwd: out, stdio: 'inherit' });
console.log('resources-backend ready:', out);
