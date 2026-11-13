import { beforeEach, describe, expect, it, vi } from 'vitest'

const stand = vi.hoisted(() => ({ appUrl: 'https://raditi.example' }))

vi.mock('@/env', () => ({ env: { web: () => ({ appUrl: stand.appUrl }) } }))

const { default: robots, dynamic } = await import('./robots')

/** The one rule of the file, with its lists as arrays. */
function rule() {
  const { rules } = robots()
  if (Array.isArray(rules)) throw new Error('one rule is expected')
  return { ...rules, disallow: [rules.disallow ?? []].flat() }
}

describe('robots.txt', () => {
  beforeEach(() => {
    stand.appUrl = 'https://raditi.example'
  })

  it('opens the public pages to every search engine', () => {
    expect(rule().userAgent).toBe('*')
    expect(rule().allow).toBe('/')
  })

  it('closes the cabinet, the sign-in pages and the API', () => {
    expect(rule().disallow).toEqual([
      '/api/',
      '/app',
      '/chats',
      '/projects',
      '/profile',
      '/settings',
      '/onboarding',
      '/preview',
      '/sign-in',
      '/sign-up',
      '/reset-password',
      '/verify-email',
    ])
    // The landing and the legal pages stay open: no closed path is a start of theirs.
    for (const open of ['/', '/terms/public-offer', '/sitemap.xml']) {
      expect(rule().disallow.filter((closed) => open.startsWith(closed))).toEqual([])
    }
  })

  it('names the sitemap and the host by the public address of the service', () => {
    expect(robots().sitemap).toBe('https://raditi.example/sitemap.xml')
    expect(robots().host).toBe('https://raditi.example')

    // Only the origin is taken: a path or a final slash of the address does not double.
    stand.appUrl = 'http://localhost:3000/'
    expect(robots().sitemap).toBe('http://localhost:3000/sitemap.xml')
    expect(robots().host).toBe('http://localhost:3000')
  })

  it('reads the address when asked, not when built', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
