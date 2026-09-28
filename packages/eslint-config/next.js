// @ts-check
import nextPlugin from '@next/eslint-plugin-next'
import { config as react } from './react.js'

/**
 * Next.js apps (apps/web).
 * @type {import('eslint').Linter.Config[]}
 */
export const config = [
  { ignores: ['.next/**', 'out/**', 'next-env.d.ts'] },
  ...react,
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
]

export default config
