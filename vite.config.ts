import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri expects a fixed port and a relative base for the bundled assets.
export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // `cargo` writes into src-tauri/target while `tauri dev` is running.
    // Watching it causes EBUSY on locked build-script executables.
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome110',
    sourcemap: true,
  },
})
