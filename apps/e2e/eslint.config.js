import { config } from '@repo/eslint-config/base'

export default [{ ignores: ['playwright-report/**', 'test-results/**'] }, ...config]
