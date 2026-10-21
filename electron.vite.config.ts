import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: {
    resolve: { alias: shared },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()]
  }
})
