import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './', // 打包进 Electron 后经 file:// 加载，必须相对路径
  server: { port: 5173, strictPort: true },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
