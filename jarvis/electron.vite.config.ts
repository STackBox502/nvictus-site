import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/** Dev server only: relax CSP for Vite HMR (inline React refresh preamble + websocket). Production keeps the strict CSP. */
const devCsp = (): Plugin => ({
  name: 'jarvis-dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
  },
});

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCsp()],
    build: {
      // Never inline assets as data: URLs — the AudioWorklet module must load from 'self' under the strict CSP.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          chat: resolve(__dirname, 'src/renderer/chat.html'),
        },
      },
    },
  },
});
