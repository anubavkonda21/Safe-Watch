/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = fileURLToPath(new URL('./src', import.meta.url));
const server = fileURLToPath(new URL('./server/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@server': server, '@': src } },
  server: {
    // Same-origin API in development: no CORS needed. Override the target with SAFEWATCH_API_TARGET.
    proxy: { '/api': { target: process.env.SAFEWATCH_API_TARGET ?? 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  test: {
    css: false,
    projects: [
      {
        extends: true,
        test: { name: 'web', environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
      },
      {
        extends: true,
        test: { name: 'server', environment: 'node', globals: true, include: ['server/**/*.test.ts'], testTimeout: 30_000, globalSetup: ['./server/test/globalSetup.ts'] },
      },
    ],
  },
});
