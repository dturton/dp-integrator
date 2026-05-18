import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vite config for the dpi admin UI.
 *
 * Dev mode: `pnpm dev` runs the Vite dev server with a proxy that forwards
 * `/api/admin/*` to the deployed dev function app. Set the target via
 * `VITE_DEV_API_TARGET` (default: dpi-func-dev). That way local UI dev hits
 * real data without needing to run the function host locally.
 *
 * Prod: built static bundle is served by Azure Static Web Apps; the linked
 * Function App handles `/api/admin/*` natively (no proxy needed).
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/admin': {
        target: process.env['VITE_DEV_API_TARGET'] ?? 'https://dpi-func-dev-auwpabjrr5flu.azurewebsites.net',
        changeOrigin: true,
        secure: true,
        // Function-key auth in dev — set VITE_DEV_FUNCTIONS_KEY and the proxy
        // attaches it. SWA prod adds the auth header transparently via Easy
        // Auth so this proxy block only runs in `vite dev`.
        configure: (proxy) => {
          const key = process.env['VITE_DEV_FUNCTIONS_KEY'];
          if (key) {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('x-functions-key', key);
            });
          }
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'production',
  },
}));
