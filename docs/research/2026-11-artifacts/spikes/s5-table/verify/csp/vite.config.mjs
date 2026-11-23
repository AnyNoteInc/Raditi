import { defineConfig } from 'vite'
export default defineConfig({ root: import.meta.dirname, logLevel: 'warn', build: { outDir: 'dist', emptyOutDir: true, target: 'es2023' } })
