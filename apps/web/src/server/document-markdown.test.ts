import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { getDocumentMarkdown } = await import('./document-markdown')

const docId = '0199a3f2-0000-7000-8000-0000000000d1'
type Read = () => Promise<{ name: string; markdown: string; html: string | null } | null>
const deps = (
  read: Read = vi.fn<Read>(async () => ({
    name: 'Аудит скорости.md',
    markdown: '# Аудит\n',
    html: null,
  })),
) => ({
  getSession: async () => ({ user: { id: 'u1' } }),
  hasRequiredConsents: async () => true,
  read,
})

describe('«Скачать .md» (plan 69, Ст12)', () => {
  it('answers the Markdown of the version as a text attachment named by the title', async () => {
    const response = await getDocumentMarkdown(
      new Request('https://raditi.ru/api/documents/x/markdown'),
      { docId },
      deps(),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('# Аудит\n')
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''%D0%90%D1%83%D0%B4%D0%B8%D1%82",
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('answers the page to read of a document of the view page as an .html attachment (plan 74, Д1)', async () => {
    const response = await getDocumentMarkdown(
      new Request('https://raditi.ru/api/documents/x/markdown'),
      { docId },
      deps(async () => ({
        name: 'Аудит скорости.html',
        markdown: '# Аудит\n',
        html: '<!doctype html><title>Аудит</title>',
      })),
    )
    expect(await response.text()).toBe('<!doctype html><title>Аудит</title>')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  })

  it('answers 404 for a document of another workspace or without a version, and 401 to a stranger', async () => {
    expect(
      (
        await getDocumentMarkdown(
          new Request('https://raditi.ru/'),
          { docId },
          deps(vi.fn(async () => null)),
        )
      ).status,
    ).toBe(404)
    expect(
      (await getDocumentMarkdown(new Request('https://raditi.ru/'), { docId: 'nope' }, deps()))
        .status,
    ).toBe(404)
    expect(
      (
        await getDocumentMarkdown(
          new Request('https://raditi.ru/'),
          { docId },
          { ...deps(), getSession: async () => null },
        )
      ).status,
    ).toBe(401)
  })
})
