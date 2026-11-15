import { createHash } from 'node:crypto'

import { badRequest, type ObjectStorage } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  downloadProjectFile,
  projectFileText,
  uploadProjectFile,
  type ProjectFileDependencies,
  type ProjectFileDownload,
  type ProjectFileUploadTarget,
} from './project-file'

// The bytes of a file of a project (docs/plan/84-projects.md, ПР8): the upload checks the session,
// the Origin, the size and the first bytes, reads a text whole for UTF-8 and secrets, and a
// download is never opened on the origin of the cabinet.

const ORIGIN = 'http://localhost:3000'
const USER_ID = '019f1a21-1800-7f00-8abc-111111111111'
const FILE_ID = '019f1a21-1800-7f00-8abc-aaaaaaaaaaaa'
const KEY = `projects/019f1a21-1800-7f00-8abc-bbbbbbbbbbbb/${FILE_ID}`
const NOW = new Date('2026-11-15T10:00:00.000Z')
const text = (value: string) => new TextEncoder().encode(value)

function setup(
  options: {
    target?: Partial<ProjectFileUploadTarget> | null
    download?: Partial<ProjectFileDownload> | null
    markReady?: boolean
  } = {},
) {
  const objects = new Map<string, Uint8Array>()
  const put = vi.fn(
    async (
      _bucket: string,
      key: string,
      body: Uint8Array | AsyncIterable<Uint8Array>,
      opts?: { sizeBytes?: number },
    ) => {
      const chunks: Uint8Array[] = []
      if (body instanceof Uint8Array) chunks.push(body)
      else for await (const chunk of body) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      if (opts?.sizeBytes !== undefined && opts.sizeBytes !== bytes.byteLength)
        throw badRequest('The stream is shorter than sizeBytes')
      objects.set(key, bytes)
    },
  )
  const storage = {
    put,
    stat: vi.fn(async (_bucket: string, key: string) => {
      const bytes = objects.get(key)
      return bytes ? { sizeBytes: bytes.byteLength } : null
    }),
    delete: vi.fn(async (_bucket: string, key: string) => {
      objects.delete(key)
    }),
    get: vi.fn(async (_bucket: string, key: string) => {
      const bytes = objects.get(key)
      return bytes
        ? (async function* () {
            yield bytes
          })()
        : null
    }),
  } as unknown as ObjectStorage
  const markReady = vi.fn(async () => options.markReady ?? true)
  const deps: ProjectFileDependencies = {
    appOrigin: () => ORIGIN,
    getSession: vi.fn(async () => ({ user: { id: USER_ID } })),
    hasRequiredConsents: vi.fn(async () => true),
    admitUpload: vi.fn(async () => true),
    findUpload: vi.fn(async () =>
      options.target === null
        ? null
        : {
            id: FILE_ID,
            key: KEY,
            kind: 'file' as const,
            mediaType: 'text/markdown',
            sizeBytes: 12,
            status: 'uploading' as const,
            expiresAt: new Date(NOW.getTime() + 3_600_000),
            ...options.target,
          },
    ),
    markReady,
    findDownload: vi.fn(async () =>
      options.download === null
        ? null
        : {
            name: 'Сайт/index.html',
            key: KEY,
            sizeBytes: 15,
            status: 'ready' as const,
            ...options.download,
          },
    ),
    storage: () => storage,
    now: () => NOW,
    onFailure: vi.fn(),
  }
  return { deps, objects, put, markReady }
}

function put(body: Uint8Array, headers: Record<string, string> = {}): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'PUT',
    headers: { origin: ORIGIN, 'content-length': String(body.byteLength), ...headers },
    body: body as BodyInit,
    duplex: 'half',
  }
  return new Request(`${ORIGIN}/api/project-files/${FILE_ID}`, init)
}

describe('PUT /api/project-files/<id>', () => {
  it('stores a text in UTF-8 and marks it ready with the hash of its bytes', async () => {
    const body = text('# Цены зимы')
    const { deps, objects, markReady } = setup({ target: { sizeBytes: body.byteLength } })
    const response = await uploadProjectFile(put(body), { id: FILE_ID }, deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fileId: FILE_ID, size: body.byteLength })
    expect(objects.get(KEY)).toEqual(Buffer.from(body))
    expect(markReady).toHaveBeenCalledWith({
      id: FILE_ID,
      sizeBytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  })

  it('refuses a text with a secret and one that is not UTF-8, storing nothing', async () => {
    const secret = text('DB_PASSWORD=Xk9#mP2$vL')
    const one = setup({ target: { sizeBytes: secret.byteLength, mediaType: 'text/x-source' } })
    const refused = await uploadProjectFile(put(secret), { id: FILE_ID }, one.deps)
    expect(refused.status).toBe(422)
    expect((await refused.json()).message).toContain('пароль или ключ')
    expect(one.objects.size).toBe(0)
    // Valid at the start, broken past the first bytes the sniff reads.
    const broken = new Uint8Array(5000).fill(0x41)
    broken[4999] = 0xd0
    const two = setup({ target: { sizeBytes: broken.byteLength } })
    const encoding = await uploadProjectFile(put(broken), { id: FILE_ID }, two.deps)
    expect(encoding.status).toBe(422)
    expect((await encoding.json()).message).toContain('UTF-8')
    expect(two.objects.size).toBe(0)
  })

  it('takes ordinary source code with a password field without a false refusal', async () => {
    const code = text(
      'export const Login = ({ onSubmit }) => <input type="password" onChange={(e) => onSubmit(e.target.value)} />\n',
    )
    const { deps } = setup({ target: { sizeBytes: code.byteLength, mediaType: 'text/x-source' } })
    expect((await uploadProjectFile(put(code), { id: FILE_ID }, deps)).status).toBe(200)
  })

  it('checks the first bytes of a document and streams it', async () => {
    const pdf = new Uint8Array(10_000).fill(0x20)
    pdf.set(text('%PDF-1.7'))
    const ok = setup({ target: { sizeBytes: pdf.byteLength, mediaType: 'application/pdf' } })
    expect((await uploadProjectFile(put(pdf), { id: FILE_ID }, ok.deps)).status).toBe(200)
    const fake = setup({ target: { sizeBytes: 9, mediaType: 'application/pdf' } })
    const refused = await uploadProjectFile(put(text('<html>xx<')), { id: FILE_ID }, fake.deps)
    expect(refused.status).toBe(422)
    expect(fake.objects.size).toBe(0)
  })

  it('refuses a foreign Origin, a size other than announced, a spent file and another user', async () => {
    const body = text('hello')
    const { deps } = setup({ target: { sizeBytes: body.byteLength } })
    expect(
      (
        await uploadProjectFile(
          put(body, { origin: 'https://evil.example' }),
          { id: FILE_ID },
          deps,
        )
      ).status,
    ).toBe(403)
    expect((await uploadProjectFile(put(text('hello!')), { id: FILE_ID }, deps)).status).toBe(400)
    const spent = setup({ target: { sizeBytes: 5, status: 'ready' } })
    expect((await uploadProjectFile(put(body), { id: FILE_ID }, spent.deps)).status).toBe(409)
    const gone = setup({ target: null })
    const missing = await uploadProjectFile(put(body), { id: FILE_ID }, gone.deps)
    expect(missing.status).toBe(404)
    expect((await missing.json()).message).toBe(projectFileText.notFound)
    // The row could not be marked ready (taken, expired): the object goes again.
    const late = setup({ target: { sizeBytes: 5 }, markReady: false })
    expect((await uploadProjectFile(put(body), { id: FILE_ID }, late.deps)).status).toBe(409)
    expect(late.objects.size).toBe(0)
  })
})

describe('GET /api/project-files/<id>', () => {
  it('gives an HTML file only as an attachment of an opaque type, never on the origin', async () => {
    const { deps, objects } = setup()
    objects.set(KEY, text('<script>1</script>'.slice(0, 15)))
    const response = await downloadProjectFile(
      new Request(`${ORIGIN}/api/project-files/${FILE_ID}`),
      { id: FILE_ID },
      deps,
    )
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': '15',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    })
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="index.html"; filename*=UTF-8''index.html`,
    )
    expect(await response.text()).toBe('<script>1</scri')
  })

  it('answers 404 for a file of someone else, one not stored and one gone from S3', async () => {
    const request = () => new Request(`${ORIGIN}/api/project-files/${FILE_ID}`)
    expect(
      (await downloadProjectFile(request(), { id: FILE_ID }, setup({ download: null }).deps))
        .status,
    ).toBe(404)
    expect(
      (
        await downloadProjectFile(
          request(),
          { id: FILE_ID },
          setup({ download: { status: 'uploading' } }).deps,
        )
      ).status,
    ).toBe(404)
    expect((await downloadProjectFile(request(), { id: FILE_ID }, setup().deps)).status).toBe(404)
    expect((await downloadProjectFile(request(), { id: 'nope' }, setup().deps)).status).toBe(404)
  })
})
