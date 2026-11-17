import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  base: './', // 打包进 Electron 后经 file:// 加载，必须相对路径
  server: { port: 5173, strictPort: true },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  define: {
    // 构建期注入应用版本号（与 package.json 同源），侧边栏品牌区展示
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
