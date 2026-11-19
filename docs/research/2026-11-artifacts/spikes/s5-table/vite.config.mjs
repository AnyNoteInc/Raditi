import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Chunks are split so that the cost of the table itself can be read apart from React and MUI,
// which the cabinet already loads.
const groups = [
  { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 50 },
  {
    name: 'mui',
    test: /node_modules[\\/](@mui|@emotion|@popperjs|react-transition-group|react-is|clsx|prop-types|stylis|hoist-non-react-statics|@babel)[\\/]/,
    priority: 40,
  },
  { name: 'tanstack-virtual', test: /node_modules[\\/]@tanstack[\\/](react-virtual|virtual-core)[\\/]/, priority: 35 },
  { name: 'tanstack-table', test: /node_modules[\\/]@tanstack[\\/]/, priority: 30 },
  { name: 'decimal', test: /node_modules[\\/]decimal\.js[\\/]/, priority: 30 },
  { name: 'xlsx', test: /node_modules[\\/](write-excel-file|fflate)[\\/]/, priority: 30 },
  { name: 'table', test: /[\\/]src[\\/]table[\\/]/, priority: 20 },
  { name: 'server-stub', test: /[\\/]src[\\/]server[\\/]/, priority: 20 },
]

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2023',
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      output: {
        codeSplitting: { groups },
      },
    },
  },
})
