import { describe, expect, it, vi } from 'vitest'

import { attachmentDisposition, getTaskFile, type TaskFileDependencies } from './task-file'

// A file the agent made for the client (docs/plan/66-chat-visuals.md, В10): signed in, with the
// current documents accepted, only what the reader of @repo/trpc found, and always a download.

const bytes = Buffer.from('PK docx')
const params = {
  taskId: '0199a3f2-0000-7000-8000-000000000001',
  fileId: '0199a3f2-0000-8000-8000-000000000002',
}

function deps(patch: Partial<TaskFileDependencies> = {}) {
  return {
    getSession: vi.fn(async () => ({ user: { id: '0199a3f2-0000-7000-8000-0000000000a1' } })),
    hasRequiredConsents: vi.fn(async () => true),
    read: vi.fn(async () => ({ name: 'Отчёт за ноябрь.docx', bytes })),
    onFailure: vi.fn(),
    ...patch,
  } satisfies TaskFileDependencies
}

const request = () => new Request('http://localhost/api/tasks/x/files/y')

describe('a file of the agent in a chat', () => {
  it('serves the bytes of the reader to its member as an attachment, never sniffed or framed', async () => {
    const d = deps()
    const response = await getTaskFile(request(), params, d)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="_____ __ ______.docx"; filename*=UTF-8''${encodeURIComponent('Отчёт за ноябрь.docx')}`,
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400, immutable')
    expect(d.read).toHaveBeenCalledExactlyOnceWith({
      userId: '0199a3f2-0000-7000-8000-0000000000a1',
      ...params,
    })
  })

  it('asks to sign in, to accept the documents, and answers someone else’s alike missing', async () => {
    expect(
      (await getTaskFile(request(), params, deps({ getSession: async () => null }))).status,
    ).toBe(401)
    expect(
      (await getTaskFile(request(), params, deps({ hasRequiredConsents: async () => false })))
        .status,
    ).toBe(428)
    expect((await getTaskFile(request(), params, deps({ read: async () => null }))).status).toBe(
      404,
    )
  })

  it('says a failed read in its own words, and logs the cause', async () => {
    const d = deps({
      read: async () => {
        throw new Error('s3 down')
      },
    })
    const response = await getTaskFile(request(), params, d)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: 'Не удалось скачать файл.' })
    expect(d.onFailure).toHaveBeenCalledOnce()
  })

  it('keeps quotes, backslashes and non-ASCII out of the plain file name', () => {
    expect(attachmentDisposition('a"b\\c (1).txt')).toBe(
      `attachment; filename="a_b_c (1).txt"; filename*=UTF-8''a%22b%5Cc%20%281%29.txt`,
    )
  })
})
