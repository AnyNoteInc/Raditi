import type { BrowserCheckpointRecord } from '@repo/db'
import { describe, expect, it } from 'vitest'

import { savedObjectOf } from './pass-facts.ts'

describe('savedObjectOf (docs/plan/57-browser-tasks.md, Б22)', () => {
  const at = new Date('2026-10-23T10:00:00Z')
  const checkpoint = (patch: Partial<BrowserCheckpointRecord> = {}): BrowserCheckpointRecord => ({
    id: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a80',
    taskId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a81',
    sessionId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a82',
    ref: {
      kind: 'post',
      objectId: '41',
      editUrl: 'https://example.ru/blog/wp-admin/post.php?post=41&action=edit&key=secret#x',
    },
    state: 'unverified',
    verified: null,
    createdAt: at,
    updatedAt: at,
    ...patch,
  })

  it('tells of a saved object by its path, never the query of its editor', () => {
    const saved = savedObjectOf(checkpoint())
    expect(saved).toEqual({
      kind: 'post',
      objectId: '41',
      state: 'unverified',
      editPath: '/blog/wp-admin/post.php',
    })
    expect(JSON.stringify(saved)).not.toMatch(/secret|example\.ru|\?/)
  })

  it('gives what the site confirmed of a verified object, and nothing of one only seen', () => {
    const verified = {
      kind: 'post' as const,
      objectId: '41',
      title: 'Скидки на зиму',
      status: 'publish' as const,
      url: 'https://example.ru/blog/skidki/?utm=1',
      editUrl: 'https://example.ru/blog/wp-admin/post.php?post=41&action=edit',
      images: 2,
      files: 1,
      featuredImage: true,
    }
    expect(savedObjectOf(checkpoint({ state: 'verified', verified }))).toEqual({
      kind: 'post',
      objectId: '41',
      state: 'verified',
      title: 'Скидки на зиму',
      status: 'publish',
      editPath: '/blog/wp-admin/post.php',
    })
    // What a read found that no longer parses is not trusted: the agent verifies it again.
    expect(savedObjectOf(checkpoint({ state: 'verified', verified: null }))?.state).toBe(
      'unverified',
    )
    expect(savedObjectOf(checkpoint({ state: 'missing' }))?.state).toBe('missing')
    expect(savedObjectOf(checkpoint({ state: 'seen' }))).toBeNull()
  })

  it('leaves out a title that may hold a contact: the agent meets those only masked', () => {
    const read = (title: string) =>
      savedObjectOf(
        checkpoint({
          state: 'verified',
          verified: {
            kind: 'post',
            objectId: '41',
            title,
            status: 'draft',
            editUrl: 'https://example.ru/wp-admin/post.php?post=41&action=edit',
            images: 0,
            files: 0,
            featuredImage: false,
          },
        }),
      )
    for (const title of [
      'Пишите на shop@example.ru',
      'Звоните +7 (900) 123-45-67',
      'Телефон 8 800 555 35 35',
    ]) {
      const saved = read(title)
      expect(saved).toMatchObject({ state: 'verified', status: 'draft' })
      expect(saved).not.toHaveProperty('title')
    }
    // Years and prices are not contacts.
    expect(read('Скидки 2026 года: 30% до 15.11')?.title).toBe('Скидки 2026 года: 30% до 15.11')
  })
})
