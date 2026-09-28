// @ts-check
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import { config as base } from './base.js'

/**
 * React libraries (packages/ui). eslint-plugin-react is left out on purpose:
 * it does not support ESLint 10 yet.
 * @type {import('eslint').Linter.Config[]}
 */
export const config = [
  ...base,
  reactHooks.configs.flat.recommended,
  { languageOptions: { globals: { ...globals.browser } } },
]

export default config
