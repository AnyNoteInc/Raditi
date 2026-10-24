import { badRequest, type ObjectStorage } from '@repo/domain'
import { attachmentLimits } from '@repo/domain/attachments/rules'
import { attachmentRefusalText } from '@repo/domain/attachments/labels'
import { describe, expect, it, vi } from 'vitest'

import {
  uploadAttachment,
  uploadText,
  type AttachmentUploadDependencies,
  type UploadTarget,
} from './attachment-upload'

const ORIGIN = 'http://localhost:3000'
const USER_ID = '019f1a21-1800-7f00-8abc-111111111111'
const ATTACHMENT_ID = '019f1a21-1800-7f00-8abc-aaaaaaaaaaaa'
const KEY = `inbox/019f1a21-1800-7f00-8abc-bbbbbbbbbbbb/${ATTACHMENT_ID}`
const NOW = new Date('2026-10-23T10:00:00.000Z')

/** A JPEG as far as the first bytes tell: the marker, then filler. */
const jpeg = (size: number) => {
  const bytes = new Uint8Array(size).fill(0x20)
  bytes.set([0xff, 0xd8, 0xff, 0xe0])
  return bytes
}

function setup(
  options: {
    target?: Partial<UploadTarget> | null
    stored?: (bytes: Uint8Array) => number | null
    markReady?: boolean
  } = {},
) {
  const objects = new Map<string, Uint8Array>()
  // Like the S3 adapter: a stream that does not match `sizeBytes` is refused (checkedLength).
  const put = vi.fn(
    async (
      _bucket: string,
      key: string,
      body: Uint8Array | AsyncIterable<Uint8Array>,
      opts?: { sizeBytes?: number },
    ) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      if (opts?.sizeBytes !== undefined && opts.sizeBytes !== bytes.byteLength)
        throw badRequest('The stream is shorter than sizeBytes')
      objects.set(key, bytes)
    },
  )
  const stat = vi.fn(async (_bucket: string, key: string) => {
    const bytes = objects.get(key)
    if (!bytes) return null
    const size = options.stored ? options.stored(bytes) : bytes.byteLength
    return size === null ? null : { sizeBytes: size }
  })
  const remove = vi.fn(async (_bucket: string, key: string) => {
    objects.delete(key)
  })
  const storage = { put, stat, delete: remove } as unknown as ObjectStorage
  const target: UploadTarget | null =
    options.target === null
      ? null
      : {
          id: ATTACHMENT_ID,
          key: KEY,
          contentType: 'image/jpeg',
          sizeBytes: 5000,
          status: 'uploading',
          expiresAt: new Date(NOW.getTime() + 3_600_000),
          ...options.target,
        }
  const deps: AttachmentUploadDependencies = {
    appOrigin: () => ORIGIN,
    getSession: vi.fn(async () => ({ user: { id: USER_ID } })),
    hasRequiredConsents: vi.fn(async () => true),
    admitUpload: vi.fn(async () => true),
    findUpload: vi.fn(async () => target),
    markReady: vi.fn(async () => options.markReady ?? true),
    storage: () => storage,
    now: () => NOW,
    onFailure: vi.fn(),
  }
  return { deps, objects, put, stat, remove }
}

function request(
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'PUT',
    headers: {
      origin: ORIGIN,
      ...(body instanceof Uint8Array ? { 'content-length': String(body.byteLength) } : {}),
      ...headers,
    },
    body: body as BodyInit | null,
    duplex: 'half',
  }
  return new Request(`${ORIGIN}/api/attachments/${ATTACHMENT_ID}`, init)
}

/** A body in chunks with no declared length, as a chunked upload sends it. */
const chunked = (...parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })

async function answer(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('PUT /api/attachments/<id>', () => {
  it('streams the announced file into the inbox, confirms it and marks it ready', async () => {
    const { deps, objects, put, stat } = setup()
    const bytes = jpeg(5000)
    const result = await answer(
      await uploadAttachment(request(bytes), { id: ATTACHMENT_ID.toUpperCase() }, deps),
    )
    expect(result).toEqual({ status: 200, body: { attachmentId: ATTACHMENT_ID, size: 5000 } })
    expect(put).toHaveBeenCalledWith('inbox', KEY, expect.anything(), {
      contentType: 'image/jpeg',
      sizeBytes: 5000,
    })
    expect(objects.get(KEY)).toEqual(Buffer.from(bytes))
    expect(stat).toHaveBeenCalledWith('inbox', KEY)
    expect(deps.findUpload).toHaveBeenCalledWith(ATTACHMENT_ID, USER_ID)
    expect(deps.markReady).toHaveBeenCalledWith({
      id: ATTACHMENT_ID,
      sizeBytes: 5000,
      contentType: 'image/jpeg',
    })
  })

  it('takes a chunked body of exactly the announced size', async () => {
    const { deps, objects } = setup({ target: { sizeBytes: 6000 } })
    const bytes = jpeg(6000)
    const response = await uploadAttachment(
      request(chunked(bytes.subarray(0, 10), bytes.subarray(10, 4500), bytes.subarray(4500))),
      { id: ATTACHMENT_ID },
      deps,
    )
    expect(response.status).toBe(200)
    expect(objects.get(KEY)?.byteLength).toBe(6000)
  })

  it('refuses a request from another origin before reading anything', async () => {
    const { deps, put } = setup()
    const result = await answer(
      await uploadAttachment(
        request(jpeg(5000), { origin: 'https://evil.example' }),
        { id: ATTACHMENT_ID },
        deps,
      ),
    )
    expect(result).toEqual({ status: 403, body: { message: uploadText.origin } })
    expect(deps.findUpload).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('asks to sign in without a session and to accept the documents without consents', async () => {
    const signedOut = setup()
    vi.mocked(signedOut.deps.getSession).mockResolvedValue(null)
    expect(
      (await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, signedOut.deps)).status,
    ).toBe(401)

    const { deps, put } = setup()
    vi.mocked(deps.hasRequiredConsents).mockResolvedValue(false)
    const result = await answer(
      await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, deps),
    )
    expect(result.status).toBe(428)
    expect(put).not.toHaveBeenCalled()
  })

  it('answers the same for a file of someone else, a missing one and a broken id', async () => {
    const foreign = setup({ target: null })
    const first = await answer(
      await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, foreign.deps),
    )
    expect(first).toEqual({ status: 404, body: { message: uploadText.notFound } })
    expect(foreign.put).not.toHaveBeenCalled()

    const { deps } = setup()
    const second = await answer(await uploadAttachment(request(jpeg(5000)), { id: 'nope' }, deps))
    expect(second).toEqual(first)
    expect(deps.findUpload).not.toHaveBeenCalled()
  })

  it('refuses a file that is no longer uploading or whose time ran out', async () => {
    for (const target of [
      { status: 'ready' as const },
      { status: 'bound' as const },
      { expiresAt: NOW },
    ]) {
      const { deps, put } = setup({ target })
      const result = await answer(
        await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, deps),
      )
      expect(result).toEqual({ status: 409, body: { message: uploadText.spent } })
      expect(put).not.toHaveBeenCalled()
    }
  })

  it('refuses a declared length over the limit or other than announced, unread', async () => {
    const big = setup()
    const tooLarge = await answer(
      await uploadAttachment(
        request(chunked(jpeg(10)), {
          'content-length': String(attachmentLimits.fileBytes + 1),
        }),
        { id: ATTACHMENT_ID },
        big.deps,
      ),
    )
    expect(tooLarge).toEqual({ status: 413, body: { message: attachmentRefusalText.too_large } })
    expect(big.put).not.toHaveBeenCalled()

    const { deps, put } = setup()
    const other = await answer(
      await uploadAttachment(request(jpeg(4999)), { id: ATTACHMENT_ID }, deps),
    )
    expect(other).toEqual({ status: 400, body: { message: uploadText.sizeMismatch } })
    expect(put).not.toHaveBeenCalled()
  })

  it('refuses a body longer than announced and leaves nothing stored', async () => {
    const { deps, objects, remove } = setup({ target: { sizeBytes: 5000 } })
    const bytes = jpeg(7000)
    const result = await answer(
      await uploadAttachment(
        request(chunked(bytes.subarray(0, 4500), bytes.subarray(4500))),
        { id: ATTACHMENT_ID },
        deps,
      ),
    )
    expect(result).toEqual({ status: 400, body: { message: uploadText.sizeMismatch } })
    expect(objects.size).toBe(0)
    expect(remove).toHaveBeenCalledWith('inbox', KEY)
    expect(deps.markReady).not.toHaveBeenCalled()
  })

  it('refuses a body shorter than announced', async () => {
    const { deps, objects } = setup({ target: { sizeBytes: 5000 } })
    const result = await answer(
      await uploadAttachment(request(chunked(jpeg(4800))), { id: ATTACHMENT_ID }, deps),
    )
    expect(result).toEqual({ status: 400, body: { message: uploadText.broken } })
    expect(objects.size).toBe(0)
    expect(deps.markReady).not.toHaveBeenCalled()
  })

  it('refuses first bytes that are not of the announced type before storing anything', async () => {
    const { deps, put } = setup()
    const fake = new Uint8Array(5000).fill(0x41)
    const result = await answer(await uploadAttachment(request(fake), { id: ATTACHMENT_ID }, deps))
    expect(result).toEqual({
      status: 422,
      body: { message: attachmentRefusalText.content_mismatch },
    })
    expect(put).not.toHaveBeenCalled()
    expect(deps.markReady).not.toHaveBeenCalled()
  })

  it('refuses a text file that is not UTF-8', async () => {
    const { deps, put } = setup({ target: { contentType: 'text/csv', sizeBytes: 4 } })
    const result = await answer(
      await uploadAttachment(
        request(new Uint8Array([0xcf, 0xf0, 0x00, 0x41])),
        { id: ATTACHMENT_ID },
        deps,
      ),
    )
    expect(result.body.message).toBe(attachmentRefusalText.text_encoding)
    expect(put).not.toHaveBeenCalled()
  })

  it('deletes the object when the stored size is not the announced one', async () => {
    const { deps, objects, remove } = setup({ stored: (bytes) => bytes.byteLength - 1 })
    const result = await answer(
      await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, deps),
    )
    expect(result).toEqual({ status: 400, body: { message: uploadText.broken } })
    expect(remove).toHaveBeenCalledWith('inbox', KEY)
    expect(objects.size).toBe(0)
    expect(deps.markReady).not.toHaveBeenCalled()
  })

  it('deletes the object when the file could not be marked ready', async () => {
    const { deps, objects } = setup({ markReady: false })
    const result = await answer(
      await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, deps),
    )
    expect(result).toEqual({ status: 409, body: { message: uploadText.spent } })
    expect(objects.size).toBe(0)
  })

  it('answers 503 and deletes the object when the storage fails, and logs no file data', async () => {
    const { deps, put, remove } = setup()
    put.mockRejectedValueOnce(new Error('S3 is down'))
    const result = await answer(
      await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, deps),
    )
    expect(result).toEqual({ status: 503, body: { message: uploadText.failed } })
    expect(remove).toHaveBeenCalledWith('inbox', KEY)
    expect(deps.onFailure).toHaveBeenCalledWith('attachment upload failed', expect.any(Error))
  })

  it('counts every upload of the user and refuses one over the limit', async () => {
    const { deps, put } = setup()
    vi.mocked(deps.admitUpload).mockResolvedValue(false)
    const result = await answer(
      await uploadAttachment(request(jpeg(5000)), { id: ATTACHMENT_ID }, deps),
    )
    expect(result).toEqual({ status: 429, body: { message: uploadText.tooOften } })
    expect(deps.admitUpload).toHaveBeenCalledWith(USER_ID)
    expect(put).not.toHaveBeenCalled()
  })
})
