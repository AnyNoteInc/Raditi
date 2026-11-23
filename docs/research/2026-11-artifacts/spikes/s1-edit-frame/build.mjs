// Bundles the React page of the spike (React 19.3.1) into dist/react.js.
import { build } from 'esbuild'
await build({
  entryPoints: ['react-app.jsx'],
  bundle: true,
  outfile: 'dist/react.js',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  target: ['chrome120', 'safari17', 'firefox120'],
  logLevel: 'warning',
})
console.log('built dist/react.js')
