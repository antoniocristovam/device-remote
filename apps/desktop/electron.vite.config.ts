import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Workspace packages are ESM sources of truth shared with the signaling server: bundle them.
const bundled = ['@rc/protocol', '@rc/crypto-proto', '@rc/signaling', 'zod'];

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: bundled } } },
  preload: { build: { externalizeDeps: { exclude: bundled } } },
  renderer: {
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
});
