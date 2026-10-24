import { describe, expect, it } from 'vitest'

import {
  browserCheckpointAfterRead,
  browserCheckpointCommitted,
  browserCheckpointRefSchema,
  browserCheckpointsBlock,
  browserFeedObjectOf,
  browserObjectStatuses,
  browserVerifiedObjectSchema,
  isBrowserVerificationPlan,
  type BrowserCheckpointRef,
  type BrowserVerificationPlan,
  type BrowserVerificationStep,
  type BrowserVerifiedObject,
} from './checkpoint.ts'
import { feedLimits, feedObjectSchema, feedObjectStatuses } from '../tasks/client-feed.ts'

const editUrl = 'https://news.example.ru/wp-admin/post.php?post=12&action=edit'
const ref: BrowserCheckpointRef = { kind: 'post', objectId: '12', editUrl }
const verified: BrowserVerifiedObject = {
  kind: 'post',
  objectId: '12',
  title: 'Открытие нового филиала',
  status: 'publish',
  url: 'https://news.example.ru/2026/10/22/otkrytie/',
  editUrl,
  images: 2,
  files: 1,
  featuredImage: true,
}

describe('checkpoints', () => {
  it('reads the reference and the verified object', () => {
    expect(browserCheckpointRefSchema.parse(ref)).toEqual(ref)
    expect(browserVerifiedObjectSchema.parse(verified)).toEqual(verified)
    const draft = { ...verified, status: 'draft', url: undefined }
    expect(browserVerifiedObjectSchema.safeParse(draft).success).toBe(true)
    expect(browserObjectStatuses).toEqual([
      'publish',
      'draft',
      'pending',
      'private',
      'future',
      'trash',
      'unknown',
    ])
  })

  it('refuses ids and addresses that could carry anything else', () => {
    for (const bad of [
      { ...ref, kind: 'page' },
      { ...ref, objectId: '' },
      { ...ref, objectId: '12/../13' },
      { ...ref, objectId: 'x'.repeat(65) },
      { ...ref, editUrl: '/wp-admin/post.php?post=12' },
      { ...ref, editUrl: 'javascript:alert(1)' },
      { ...ref, editUrl: 'https://admin:pass@news.example.ru/wp-admin/' },
      { ...ref, editUrl: 'https://news.example.ru/\nX' },
      { ...ref, editUrl: `https://news.example.ru/${'a'.repeat(2048)}` },
      { ...ref, extra: 1 },
    ])
      expect(browserCheckpointRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const bad of [
      { ...verified, status: 'published' },
      { ...verified, images: -1 },
      { ...verified, files: 1.5 },
      { ...verified, title: 'x'.repeat(1001) },
      { ...verified, content: '<p>…</p>' },
    ])
      expect(browserVerifiedObjectSchema.safeParse(bad).success).toBe(false)
  })

  it('moves to unverified on a commit and to what the site says on a read', () => {
    expect(browserCheckpointCommitted()).toBe('unverified')
    expect(browserCheckpointAfterRead('unverified', { state: 'verified', object: verified })).toBe(
      'verified',
    )
    expect(browserCheckpointAfterRead('verified', { state: 'missing' })).toBe('missing')
    // A failed read changes nothing that was known.
    for (const state of ['seen', 'unverified', 'verified', 'missing'] as const)
      expect(browserCheckpointAfterRead(state, { state: 'unreadable' })).toBe(state)
  })

  it('blocks a new object or another publish while a saved one is unconfirmed', () => {
    expect(browserCheckpointsBlock([])).toBe(false)
    expect(browserCheckpointsBlock(['seen', 'verified', 'missing'])).toBe(false)
    expect(browserCheckpointsBlock(new Set(['verified', 'unverified'] as const))).toBe(true)
  })
})

describe('feed objects', () => {
  it('tells the client what the site confirmed: kind, title, status and links, no id', () => {
    const line = browserFeedObjectOf({ ref, state: 'verified', verified })
    expect(line).toEqual({
      kind: 'post',
      title: 'Открытие нового филиала',
      status: 'published',
      url: verified.url,
      editUrl,
    })
    // The feed's own schema writes it: one vocabulary of objects for the client.
    expect(feedObjectSchema.parse(line)).toEqual(line)
    expect(line).not.toHaveProperty('objectId')
    const draft = browserFeedObjectOf({
      ref,
      state: 'verified',
      verified: { ...verified, status: 'draft', url: undefined },
    })
    expect(draft).not.toHaveProperty('url')
    expect(draft?.status).toBe('draft')
  })

  it('names every status of the site in the words of the feed', () => {
    const statuses = browserObjectStatuses.map(
      (status) =>
        browserFeedObjectOf({ ref, state: 'verified', verified: { ...verified, status } })?.status,
    )
    expect(statuses).toEqual([
      'published',
      'draft',
      'pending',
      'private',
      'scheduled',
      'trashed',
      'unconfirmed',
    ])
    for (const status of statuses) expect(feedObjectStatuses).toContain(status)
  })

  it('says when the site did not confirm, or the object is gone', () => {
    expect(browserFeedObjectOf({ ref, state: 'unverified', verified: null })).toEqual({
      kind: 'post',
      title: null,
      status: 'unconfirmed',
      editUrl,
    })
    expect(browserFeedObjectOf({ ref, state: 'missing', verified })).toEqual({
      kind: 'post',
      title: null,
      status: 'missing',
    })
    // `verified` without what was found is not trusted.
    expect(browserFeedObjectOf({ ref, state: 'verified', verified: null })?.status).toBe(
      'unconfirmed',
    )
    expect(browserFeedObjectOf({ ref, state: 'seen', verified: null })).toBeNull()
  })

  it('clips a long title on whole characters, as the feed writes it', () => {
    const title = `${'😀'.repeat(150)}${'я'.repeat(100)}`
    const line = browserFeedObjectOf({ ref, state: 'verified', verified: { ...verified, title } })
    expect(line?.title?.length).toBeLessThanOrEqual(feedLimits.objectTitle)
    expect(line?.title?.startsWith('😀')).toBe(true)
    expect(feedObjectSchema.safeParse(line).success).toBe(true)
  })
})

describe('isBrowserVerificationPlan', () => {
  const nonce: BrowserVerificationStep = {
    id: 'nonce',
    method: 'GET',
    path: '/wp-admin/admin-ajax.php?action=rest-nonce',
    readAs: 'text',
  }
  const post: BrowserVerificationStep = {
    id: 'post',
    method: 'GET',
    path: '/wp-json/wp/v2/posts/12?context=edit',
    headers: { 'X-WP-Nonce': { fromStep: 'nonce' } },
    readAs: 'json',
  }
  const plan = (steps: BrowserVerificationStep[]): BrowserVerificationPlan => ({
    steps,
    read: () => ({ state: 'unreadable' }),
  })

  it('takes a few GET requests to paths of the site, a header from an earlier step', () => {
    expect(isBrowserVerificationPlan(plan([nonce, post]))).toBe(true)
    expect(
      isBrowserVerificationPlan(plan([{ ...post, headers: { Accept: 'application/json' } }])),
    ).toBe(true)
  })

  it('refuses anything else', () => {
    for (const steps of [
      [],
      [nonce, post, { ...post, id: 'a' }, { ...post, id: 'b' }, { ...post, id: 'c' }],
      [post, nonce],
      [nonce, { ...nonce }],
      [{ ...nonce, id: 'Nonce' }],
      [{ ...nonce, method: 'POST' as 'GET' }],
      [{ ...nonce, path: 'https://evil.example.com/' }],
      [{ ...nonce, path: '//evil.example.com/' }],
      [{ ...nonce, path: '/wp-json/../wp-admin/users.php' }],
      [{ ...nonce, path: '/wp-admin/ x' }],
      [{ ...nonce, headers: { Cookie: 'wordpress_logged_in=1' } }],
      [{ ...nonce, headers: { authorization: 'Bearer x' } }],
      [{ ...nonce, headers: { 'X-A': 'one\r\nX-B: two' } }],
      [{ ...nonce, headers: { 'X A': 'x' } }],
    ] as BrowserVerificationStep[][])
      expect(isBrowserVerificationPlan(plan(steps)), JSON.stringify(steps).slice(0, 120)).toBe(
        false,
      )
  })
})
