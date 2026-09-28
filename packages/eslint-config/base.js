// @ts-check
import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import onlyWarn from 'eslint-plugin-only-warn'
import turboPlugin from 'eslint-plugin-turbo'
import tseslint from 'typescript-eslint'

/**
 * Shared config for every package. `only-warn` turns errors into warnings,
 * so each package runs `eslint --max-warnings 0`.
 * @type {import('eslint').Linter.Config[]}
 */
export const config = [
  { ignores: ['dist/**', 'coverage/**', '.turbo/**', '.vitest/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: { turbo: turboPlugin, onlyWarn },
    rules: {
      'turbo/no-undeclared-env-vars': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default config
