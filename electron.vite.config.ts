import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: {
    resolve: { alias: shared },
    // index = Lumen's desktop UI, emu = EmuStart's UI in fullscreen mode (each a single sandboxed file)
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), emu: resolve(__dirname, 'src/preload/emu.ts') } } }
  },
  renderer: {
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()]
  }
})
