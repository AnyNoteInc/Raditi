import { describe, expect, it } from 'vitest'

import { DEFAULT_AFTER_SIGN_IN, safeRedirectTarget } from './safe-redirect'

describe('safeRedirectTarget', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeRedirectTarget('/app')).toBe('/app')
    expect(safeRedirectTarget('/app/tasks/42?tab=log#end')).toBe('/app/tasks/42?tab=log#end')
    expect(safeRedirectTarget('/terms/consent')).toBe('/terms/consent')
    expect(safeRedirectTarget('/reset-password/new?token=abc')).toBe(
      '/reset-password/new?token=abc',
    )
  })

  it('normalises dot segments without leaving the site', () => {
    expect(safeRedirectTarget('/app/../settings')).toBe('/settings')
    expect(safeRedirectTarget('/app/./tasks/%2e%2e/sites')).toBe('/app/sites')
  })

  it.each([
    null,
    undefined,
    '',
    'app',
    'https://evil.example/app',
    '//evil.example/app',
    '/\\evil.example',
    '/\tevil.example',
    'javascript:alert(1)',
    '/api/auth/sign-out',
    '/api',
    `/${'a'.repeat(3000)}`,
  ])('falls back for %j', (raw) => {
    expect(safeRedirectTarget(raw)).toBe(DEFAULT_AFTER_SIGN_IN)
  })

  // Each one is a single-slash path, but parsing collapses the dot segment into "//evil.example".
  it.each([
    '/.//evil.example',
    '/..//evil.example',
    '/%2e//evil.example',
    '/%2E//evil.example',
    '/%2e%2e//evil.example',
    '/app/..//evil.example',
    '/app/%2e%2e//evil.example',
    '/.///evil.example',
    '/./\\evil.example',
    '/.\\/evil.example',
    '/..\\\\evil.example',
    '/%2e/\\evil.example',
    '/app/..\\/evil.example',
  ])('falls back when %j normalises to a protocol-relative URL', (raw) => {
    expect(safeRedirectTarget(raw)).toBe(DEFAULT_AFTER_SIGN_IN)
  })

  it.each([
    '/sign-in',
    '/sign-in/',
    '/sign-in?next=/app',
    '/sign-up',
    '/reset-password',
    '/verify-email',
  ])('falls back for the signed-out-only page %j: it would send the user away again', (raw) => {
    expect(safeRedirectTarget(raw)).toBe(DEFAULT_AFTER_SIGN_IN)
  })

  it('uses the given fallback', () => {
    expect(safeRedirectTarget('//evil.example', '/')).toBe('/')
    expect(safeRedirectTarget('/.//evil.example', '/')).toBe('/')
  })
})
