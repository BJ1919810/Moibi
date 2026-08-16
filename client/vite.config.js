import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5173,
    // 忽略点文件（编辑器/工具临时文件），避免文件监视器 EBUSY 崩溃
    watch: { ignored: /(^|[\\/])\./ },
  },
});