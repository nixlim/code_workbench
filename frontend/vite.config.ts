import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.CODE_WORKBENCH_API_TARGET ?? 'http://127.0.0.1:5174';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts'
  },
  server: {
    proxy: {
      '/api': apiTarget
    }
  }
});
