import type { PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import type { ChatContext } from './context.ts'
import { issuePageView, readChatImage, readDocumentText } from './documents.ts'
import { pageKeys, readPageView } from './page-tokens.ts'

const userId = 'user-1'
const taskId = '0199a3f2-0000-7000-8000-0000000000b1'
const fileId = '0199a3f2-0000-8000-8000-0000000000f1'

function setup(name: string, body: Uint8Array, task = true) {
  const db = {
    task: { findFirst: vi.fn(async () => (task ? { id: taskId } : null)) },
    taskEvent: {
      findFirst: vi.fn(async () => ({
        payload: { v: 1, fileId, name, sizeBytes: body.byteLength },
      })),
    },
  } as unknown as Pick<PrismaClient, 'task' | 'taskEvent'>
  const storage = {
    get: vi.fn(async () =>
      (async function* () {
        yield body
      })(),
    ),
  }
  return { db, storage }
}

const keys = pageKeys('a-secret-of-the-pages-that-is-long-enough')
const chat = {
  pageViews: { origin: 'https://pages.example', appUrl: 'https://app.example', keys },
} as unknown as ChatContext

describe('issuePageView (docs/plan/67, Д3)', () => {
  it('signs five minutes of a page of the chat for the user', async () => {
    const { db } = setup('Отчёт.html', new Uint8Array(1))
    const { url, expiresAt } = await issuePageView(db, chat, { userId, taskId, fileId }, 1000)
    expect(url).toMatch(/^https:\/\/pages\.example\/v\/[\w-]+\.[\w-]+$/)
    expect(expiresAt).toBe(new Date(1000 + 300_000).toISOString())
    expect(readPageView(keys.view, url.split('/v/')[1]!, 1000)).toEqual({
      taskId,
      fileId,
      userId,
      expiresAt: 301_000,
    })
  })

  it('refuses a file that is no page, a chat of someone else and pages that are off', async () => {
    await expect(
      issuePageView(setup('a.md', new Uint8Array(1)).db, chat, { userId, taskId, fileId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      issuePageView(setup('a.html', new Uint8Array(1), false).db, chat, { userId, taskId, fileId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      issuePageView(
        setup('a.html', new Uint8Array(1)).db,
        { ...chat, pageViews: null },
        {
          userId,
          taskId,
          fileId,
        },
      ),
    ).rejects.toMatchObject({ code: 'PAGES_UNAVAILABLE' })
  })
})

describe('readDocumentText (docs/plan/67, Д5)', () => {
  it('reads the text of a Markdown document and tells bytes that are not UTF-8', async () => {
    const ok = setup('Статья.md', new TextEncoder().encode('# Статья'))
    await expect(readDocumentText(ok.db, ok.storage, { userId, taskId, fileId })).resolves.toEqual({
      readable: true,
      text: '# Статья',
      truncated: false,
    })
    const bad = setup('Статья.md', Uint8Array.from([0xcf, 0xf0]))
    await expect(
      readDocumentText(bad.db, bad.storage, { userId, taskId, fileId }),
    ).resolves.toEqual({
      readable: false,
    })
    const page = setup('a.html', new Uint8Array(1))
    await expect(
      readDocumentText(page.db, page.storage, { userId, taskId, fileId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('readChatImage (docs/plan/67, Д5)', () => {
  it('serves a picture by its bytes and never an SVG named as a picture', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    const ok = setup('схема.png', png)
    const image = await readChatImage(ok.db, ok.storage, { userId, taskId, fileId })
    expect(image?.type).toBe('image/png')
    expect(Array.from(image!.bytes)).toEqual(Array.from(png))
    const svg = setup('схема.png', new TextEncoder().encode('<svg onload="alert(1)"/>'))
    await expect(readChatImage(svg.db, svg.storage, { userId, taskId, fileId })).resolves.toBeNull()
    const named = setup('схема.svg', png)
    await expect(
      readChatImage(named.db, named.storage, { userId, taskId, fileId }),
    ).resolves.toBeNull()
  })
})
