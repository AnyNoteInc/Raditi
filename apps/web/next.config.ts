import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { loadEnvConfig } from '@next/env'
import createMDX from '@next/mdx'
import type { NextConfig } from 'next'

/** The monorepo root (pnpm-workspace.yaml), walking up from `startDir`. */
function findWorkspaceRoot(startDir: string): string | undefined {
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

// Next reads .env files only from the app directory, while the monorepo keeps one .env at the
// root. Next has already called loadEnvConfig for apps/web, so a forced reload is needed; it
// never overrides variables that are already exported (CI, containers). The standalone server
// does not run this file: in production the environment comes from the container.
const workspaceRoot = findWorkspaceRoot(process.cwd())
if (workspaceRoot) {
  loadEnvConfig(workspaceRoot, process.env.NODE_ENV === 'development', undefined, true)
}

const withMDX = createMDX({
  extension: /\.(md|mdx)$/,
  // Plugin names, not functions: Turbopack passes loader options to Rust.
  options: { remarkPlugins: ['remark-gfm'] },
})

// Directives that need no allowlist of scripts. Images come only from the site itself (the
// avatar route, a chosen photo's preview as blob:) and the captcha, so a stored external
// address can never make the browser call another host.
// TODO(M8): full CSP (script-src and frame-src with per-request nonces from the proxy, plus
// smartcaptcha.cloud.yandex.ru for the captcha script and frame).
const contentSecurityPolicy = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
].join('; ')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Production is served over https only (APP_URL is checked); browsers ignore it on plain http.
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
]

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep the development indicator clear of the account menu at the sidebar's foot.
  devIndicators: { position: 'bottom-right' },
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources (NodeNext imports with .ts extensions).
  transpilePackages: [
    '@repo/auth',
    '@repo/db',
    '@repo/domain',
    '@repo/mail',
    '@repo/notifications',
    '@repo/observability',
    '@repo/storage',
    '@repo/trpc',
    '@repo/ui',
    '@repo/vault',
    '@repo/yookassa',
  ],
  // Loaded by Node at runtime instead of being bundled: the pg driver and Prisma's runtime.
  serverExternalPackages: ['pg', '@prisma/client', '@prisma/adapter-pg'],
  ...(workspaceRoot ? { outputFileTracingRoot: workspaceRoot } : {}),
  experimental: {
    // Next copies the body of every request that passes proxy.ts (every page) into memory and
    // holds it until the request ends, for any sender; the default is 10 MB. A page takes a
    // body only as a server action, which Next limits to 1 MB by itself. The API routes do not
    // pass the proxy: their limits are in server/body-limit.ts.
    proxyClientMaxBodySize: '1mb',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default withMDX(nextConfig)
