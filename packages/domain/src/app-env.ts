import { z } from 'zod'

/**
 * Platform environment. Required everywhere and never defaulted: a missing or misspelt
 * APP_ENV must stop the service, not silently turn production checks off.
 */
export const appEnvs = ['development', 'test', 'production'] as const
export type AppEnv = (typeof appEnvs)[number]

export const appEnvSchema = z.enum(appEnvs, {
  error: () => 'APP_ENV must be one of development, test, production',
})

export const isProduction = (env: AppEnv): boolean => env === 'production'
