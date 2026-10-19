import { existsSync } from 'node:fs'

import { DomainError, PREVIEW_OPEN_PATH } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { openPreviewRoute, type PreviewOpenDependencies } from './preview-open'

const HOST = 'site-abcd1234-chat-ef5678.localhost'
const ENTRY = `http://${HOST}:8090/__raditi/enter?t=${'A'.repeat(43)}&to=%2F`

function deps(patch: Partial<PreviewOpenDependencies> = {}) {
  const open = vi.fn<PreviewOpenDependencies['open']>(async () => ({ url: ENTRY }))
  const value: PreviewOpenDependencies = {
    preview: () => ({ baseDomain: 'localhost', scheme: 'http', publicPort: 8090 }),
    getSession: async () => ({ user: { id: 'user-1' } }),
    hasRequiredConsents: async () => true,
    open,
    onFailure: vi.fn(),
    ...patch,
  }
  return { value, open: patch.open ? vi.mocked(patch.open) : open }
}

const get = (query: string) => new Request(`http://localhost:3000/preview/open${query}`)

describe('/preview/open', () => {
  it('is the route the gateway sends visitors to', () => {
    const route = new URL(`../app${PREVIEW_OPEN_PATH}/route.ts`, import.meta.url)
    expect(existsSync(route)).toBe(true)
  })

  it('gives a member a ticket and sends them to the gateway entry', async () => {
    const { value, open } = deps()
    const response = await openPreviewRoute(
      get(`?host=${HOST}&path=${encodeURIComponent('/shop/?a=1')}`),
      value,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(ENTRY)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(open).toHaveBeenCalledWith({ userId: 'user-1', hostname: HOST, to: '/shop/?a=1' })
  })

  it('answers a foreign preview exactly like a missing one or a bad address', async () => {
    const foreign = await openPreviewRoute(
      get(`?host=${HOST}`),
      deps({
        open: vi.fn(async () => {
          throw new DomainError('NOT_FOUND', 'No such site among the sites of the user', 404)
        }),
      }).value,
    )
    const answers = [foreign]
    for (const query of [
      '',
      '?host=example.ru',
      `?host=${HOST}.evil.example`,
      `?host=${HOST}&host=${HOST}`,
      `?host=site-abcd1234-chat-ef5678.example.ru`,
    ]) {
      const { value, open } = deps()
      answers.push(await openPreviewRoute(get(query), value))
      expect(open, query).not.toHaveBeenCalled()
    }
    const bodies = await Promise.all(answers.map((answer) => answer.text()))
    for (const [index, answer] of answers.entries()) {
      expect(answer.status).toBe(404)
      expect(bodies[index]).toBe(bodies[0])
    }
    expect(bodies[0]).toContain('Страница не найдена')
    // Previews are off: no host is a preview.
    const off = deps({ preview: () => null })
    expect((await openPreviewRoute(get(`?host=${HOST}`), off.value)).status).toBe(404)
    expect(off.open).not.toHaveBeenCalled()
  })

  it('sends the gateway only paths of the preview itself', async () => {
    for (const path of [
      '//evil.example',
      '/\\evil.example',
      'http://evil.example',
      '/a\r\nb',
      '/#x',
    ]) {
      const { value, open } = deps()
      await openPreviewRoute(get(`?host=${HOST}&path=${encodeURIComponent(path)}`), value)
      expect(open, path).toHaveBeenCalledWith(expect.objectContaining({ to: '/' }))
    }
    const { value, open } = deps()
    await openPreviewRoute(get(`?host=${HOST}&path=/a&path=/b`), value)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ to: '/' }))
  })

  it('asks a visitor without a session to sign in and brings them back', async () => {
    const { value, open } = deps({ getSession: async () => null })
    const query = `?host=${HOST}&path=${encodeURIComponent('/shop/')}`
    const response = await openPreviewRoute(get(query), value)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      `/sign-in?next=${encodeURIComponent(`/preview/open${query}`)}`,
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('sends a user who has not accepted the current documents to accept them', async () => {
    const { value, open } = deps({ hasRequiredConsents: async () => false })
    const response = await openPreviewRoute(get(`?host=${HOST}`), value)
    expect(response.headers.get('location')).toBe('/onboarding/consents')
    expect(open).not.toHaveBeenCalled()
  })

  it('says in Russian why the preview cannot open now', async () => {
    const notReady = await openPreviewRoute(
      get(`?host=${HOST}`),
      deps({
        open: vi.fn(async () => {
          throw new DomainError('PREVIEW_NOT_READY', 'The preview is being built', 409)
        }),
      }).value,
    )
    expect(notReady.status).toBe(503)
    const text = await notReady.text()
    expect(text).toContain('Предпросмотр готовится')
    expect(text).toContain('http-equiv="refresh"')

    // Pending or building: openPreview refuses `/preview` as not ready — the same page, which
    // keeps asking until the preview serves.
    const building = await openPreviewRoute(
      get(`?host=${HOST}`),
      deps({
        open: vi.fn(async () => {
          throw new DomainError('CHAT_COMMAND_UNAVAILABLE', 'refused', 409, {
            command: 'preview',
            refusal: 'preview_not_ready',
          })
        }),
      }).value,
    )
    expect(building.status).toBe(503)
    expect(await building.text()).toBe(text)

    const refused = await openPreviewRoute(
      get(`?host=${HOST}`),
      deps({
        open: vi.fn(async () => {
          throw new DomainError('CHAT_COMMAND_UNAVAILABLE', 'refused', 409, {
            command: 'preview',
            refusal: 'preview_failed',
          })
        }),
      }).value,
    )
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('Предпросмотр не удалось подготовить')
  })

  it('logs a failure of its own and tells the visitor to come back later', async () => {
    const { value } = deps({
      open: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    })
    const response = await openPreviewRoute(get(`?host=${HOST}`), value)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('Сервис временно недоступен')
    expect(value.onFailure).toHaveBeenCalledWith('preview open', expect.any(Error))
  })
})
