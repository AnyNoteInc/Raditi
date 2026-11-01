import { describe, expect, it } from 'vitest'

import {
  browserAddressSecure,
  chatRequirements,
  defaultRequirements,
  siteCapabilities,
  type SiteCapabilityFacts,
} from './site-capabilities.ts'

const site = (facts: Partial<SiteCapabilityFacts> = {}): SiteCapabilityFacts => ({
  status: 'active',
  setup: 'done',
  hasRepository: true,
  browserConfigured: true,
  browserStack: true,
  secureAddress: true,
  ...facts,
})

describe('siteCapabilities', () => {
  it('gives a connected site with its repository both ways of working', () => {
    expect(siteCapabilities(site())).toEqual({ repository: 'ready', browser: 'ready' })
  })

  it('tells the repository of a site by its import, its row and its connection', () => {
    const repository = (facts: Partial<SiteCapabilityFacts>) =>
      siteCapabilities(site(facts)).repository
    expect(repository({ status: 'onboarding', setup: 'pending', hasRepository: false })).toBe(
      'importing',
    )
    expect(repository({ status: 'onboarding', setup: 'failed', hasRepository: false })).toBe(
      'failed',
    )
    // Imported and not yet connected (M4): the repository is there, the site takes no code task.
    expect(repository({ status: 'onboarding', setup: 'done' })).toBe('inactive')
    // A site added for the browser alone: no source, no import, no repository.
    expect(repository({ status: 'onboarding', setup: null, hasRepository: false })).toBe('absent')
    // Connected without a repository row — written by a stand, never by the product.
    expect(repository({ status: 'active', setup: null, hasRepository: false })).toBe('absent')
  })

  it('opens the browser on a site that is not connected yet, and on none that is closed', () => {
    const facts = { setup: null, hasRepository: false } as const
    expect(siteCapabilities(site({ ...facts, status: 'onboarding' }))).toEqual({
      repository: 'absent',
      browser: 'ready',
    })
    for (const status of ['paused', 'disconnected', 'archived'] as const) {
      expect(siteCapabilities(site({ status }))).toEqual({
        repository: 'inactive',
        browser: 'closed',
      })
    }
  })

  it('offers no browser where the platform has none, whatever the site', () => {
    expect(siteCapabilities(site({ browserConfigured: false })).browser).toBe('not_configured')
    expect(siteCapabilities(site({ status: 'archived', browserConfigured: false })).browser).toBe(
      'closed',
    )
  })
})

describe('a stack without the browser', () => {
  it('is a site the platform cannot open, and says so before its address does', () => {
    expect(siteCapabilities(site({ browserStack: false })).browser).toBe('unsupported')
    expect(siteCapabilities(site({ browserStack: false, secureAddress: false })).browser).toBe(
      'unsupported',
    )
  })

  it('leaves the words of a closed site and of a platform without a browser', () => {
    expect(siteCapabilities(site({ browserStack: false, status: 'paused' })).browser).toBe('closed')
    expect(siteCapabilities(site({ browserStack: false, browserConfigured: false })).browser).toBe(
      'not_configured',
    )
  })
})

describe('the address of a site for the browser', () => {
  it('opens only https sites in production, any address outside it', () => {
    expect(browserAddressSecure('https://news.example.ru', 'production')).toBe(true)
    expect(browserAddressSecure('http://news.example.ru', 'production')).toBe(false)
    expect(browserAddressSecure('http://wp.raditi.test', 'development')).toBe(true)
    expect(browserAddressSecure('http://news.example.ru', null)).toBe(true)
  })

  it('says why a site with an http address takes no task in the browser', () => {
    expect(siteCapabilities(site({ secureAddress: false }))).toEqual({
      repository: 'ready',
      browser: 'insecure',
    })
    expect(siteCapabilities(site({ secureAddress: false, browserConfigured: false })).browser).toBe(
      'not_configured',
    )
    expect(siteCapabilities(site({ secureAddress: false, status: 'paused' })).browser).toBe(
      'closed',
    )
  })
})

describe('chatRequirements', () => {
  const both = { repository: true, browser: true }
  const code = { repository: true, browser: false }
  const live = { repository: false, browser: true }

  it.each([
    ['ready', 'ready', 'ready', both],
    ['ready', 'insecure', 'ready', code],
    ['ready', 'not_configured', 'ready', code],
    ['ready', 'unsupported', 'ready', code],
    ['absent', 'ready', 'ready', live],
    ['importing', 'ready', 'importing', live],
    ['failed', 'ready', 'import_failed', live],
    ['inactive', 'ready', 'ready', live],
    ['absent', 'insecure', 'insecure', null],
    ['importing', 'insecure', 'insecure', null],
    ['failed', 'insecure', 'insecure', null],
    ['inactive', 'insecure', 'insecure', null],
    ['absent', 'not_configured', 'unavailable', null],
    ['importing', 'unsupported', 'unavailable', null],
    ['failed', 'not_configured', 'unavailable', null],
    ['inactive', 'unsupported', 'unavailable', null],
    ['inactive', 'closed', 'closed', null],
  ] as const)('%s and %s: %s', (repository, browser, state, requirements) => {
    expect(chatRequirements({ repository, browser })).toEqual({ state, requirements })
  })

  it('reads a real site: a stack without the browser gives a chat with the code alone', () => {
    expect(chatRequirements(siteCapabilities(site({ browserStack: false })))).toEqual({
      state: 'ready',
      requirements: code,
    })
    expect(
      chatRequirements(siteCapabilities(site({ browserStack: false, hasRepository: false }))),
    ).toEqual({ state: 'unavailable', requirements: null })
  })

  it('hands out a copy: a change of the answer stays in it', () => {
    const { requirements } = chatRequirements({ repository: 'ready', browser: 'ready' })
    requirements!.browser = false
    expect(chatRequirements({ repository: 'ready', browser: 'ready' }).requirements).toEqual(both)
  })
})

describe('defaultRequirements', () => {
  it('takes the repository where it is ready, the browser where only it is, else the repository', () => {
    expect(defaultRequirements({ repository: 'ready', browser: 'ready' })).toEqual({
      repository: true,
      browser: false,
    })
    expect(defaultRequirements({ repository: 'absent', browser: 'ready' })).toEqual({
      repository: false,
      browser: true,
    })
    expect(defaultRequirements({ repository: 'importing', browser: 'not_configured' })).toEqual({
      repository: true,
      browser: false,
    })
  })

  it('hands out a copy: the frozen constants of the domain stay as they are', () => {
    const requirements = defaultRequirements({ repository: 'ready', browser: 'ready' })
    requirements.browser = true
    expect(defaultRequirements({ repository: 'ready', browser: 'ready' }).browser).toBe(false)
  })
})
