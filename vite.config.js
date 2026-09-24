import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(rootDir, 'web'),
  plugins: [react()],
  build: {
    outDir: path.join(rootDir, 'web', 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // web/src imports display helpers from ../../shared
    fs: { allow: [rootDir] },
    proxy: { '/api': 'http://localhost:3000' },
  },
});
