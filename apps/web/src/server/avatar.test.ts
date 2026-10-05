import type { ObjectStorage } from '@repo/domain'
import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  deleteAvatar,
  getAvatar,
  MAX_AVATAR_REQUEST_BYTES,
  uploadAvatar,
  type AvatarDependencies,
} from './avatar'

const ORIGIN = 'http://localhost:3000'
const USER_ID = '019f1a21-1800-7f00-8abc-111111111111'
const OTHER_USER_ID = '019f1a21-1800-7f00-8abc-222222222222'
const OLD_FILENAME = 'b3b10e47-9674-4b1c-bb23-9349218db1d6.webp'
const OLD_IMAGE = `/api/profile/avatar/${USER_ID}/${OLD_FILENAME}`
const OLD_KEY = `avatars/${USER_ID}/${OLD_FILENAME}`
let imageBytes: Uint8Array

beforeAll(async () => {
  imageBytes = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff6820' } })
      .png()
      .toBuffer(),
  )
})

function setup(image: string | null = null) {
  const user = { image }
  const objects = new Map<string, Uint8Array>()
  const put = vi.fn(async (_bucket: string, key: string, bytes: Uint8Array) => {
    objects.set(key, bytes)
  })
  const remove = vi.fn(async (_bucket: string, key: string) => {
    objects.delete(key)
  })
  const get = vi.fn(async (_bucket: string, key: string) => {
    const bytes = objects.get(key)
    return bytes
      ? (async function* () {
          yield bytes
        })()
      : null
  })
  const storage = { put, delete: remove, get } as unknown as ObjectStorage
  const deps: AvatarDependencies = {
    appOrigin: () => ORIGIN,
    getSession: vi.fn(async () => ({ user: { id: USER_ID } })),
    hasRequiredConsents: vi.fn(async () => true),
    admitUpload: vi.fn(async () => true),
    getUserImage: vi.fn(async () => ({ image: user.image })),
    setUserImage: vi.fn(async (_id, previous, next) => {
      if (user.image !== previous) return false
      user.image = next
      return true
    }),
    storage: () => storage,
    onFailure: vi.fn(),
  }
  return { deps, user, objects, put, remove, get }
}

function upload(headers: Record<string, string> = {}, extra?: (form: FormData) => void) {
  const form = new FormData()
  form.set(
    'file',
    new File([imageBytes as Uint8Array<ArrayBuffer>], 'photo.png', { type: 'image/png' }),
  )
  extra?.(form)
  return new Request(`${ORIGIN}/api/profile/avatar`, {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body: form,
  })
}

const deleteRequest = (origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/profile/avatar`, {
    method: 'DELETE',
    headers: origin === null ? {} : { origin },
  })

describe('avatar mutations', () => {
  it('requires authentication for upload and removal before touching storage or profile', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.getSession = vi.fn(async () => null)
    expect((await uploadAvatar(upload(), state.deps)).status).toBe(401)
    expect((await deleteAvatar(deleteRequest(), state.deps)).status).toBe(401)
    expect(state.deps.getUserImage).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
    expect(state.remove).not.toHaveBeenCalled()
  })

  it('rejects cross-origin and missing-origin mutations', async () => {
    const state = setup(OLD_IMAGE)
    for (const origin of [
      'https://foreign.example',
      'null',
      'http://localhost:3000.evil.example',
    ]) {
      const request = upload({ origin })
      expect((await uploadAvatar(request, state.deps)).status).toBe(403)
      expect(request.bodyUsed).toBe(false)
      expect((await deleteAvatar(deleteRequest(origin), state.deps)).status).toBe(403)
    }
    expect((await deleteAvatar(deleteRequest(null), state.deps)).status).toBe(403)
    expect(state.deps.getUserImage).not.toHaveBeenCalled()
    expect(state.deps.hasRequiredConsents).not.toHaveBeenCalled()
    expect(state.deps.admitUpload).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
  })

  it('requires the current mandatory consents for an upload (152-FZ)', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.hasRequiredConsents = vi.fn(async () => false)
    const request = upload()

    const refused = await uploadAvatar(request, state.deps)
    expect(refused.status).toBe(428)
    expect(await refused.json()).toEqual({
      message: 'Примите обновлённые документы, чтобы продолжить',
    })
    expect(state.deps.hasRequiredConsents).toHaveBeenCalledWith(request.headers)
    expect(request.bodyUsed).toBe(false)

    expect(state.deps.admitUpload).not.toHaveBeenCalled()
    expect(state.deps.getUserImage).not.toHaveBeenCalled()
    expect(state.deps.setUserImage).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
    expect(state.remove).not.toHaveBeenCalled()
    expect(state.user.image).toBe(OLD_IMAGE)
  })

  it('removes the avatar without the current consents: deleting own data needs none (152-FZ)', async () => {
    const state = setup(OLD_IMAGE)
    state.objects.set(OLD_KEY, imageBytes)
    state.deps.hasRequiredConsents = vi.fn(async () => false)

    const removal = await deleteAvatar(deleteRequest(), state.deps)

    expect(removal.status).toBe(200)
    expect(await removal.json()).toEqual({ image: null })
    expect(state.user.image).toBeNull()
    expect(state.remove).toHaveBeenCalledExactlyOnceWith('artifacts', OLD_KEY)
    expect(state.objects.has(OLD_KEY)).toBe(false)
    // The session and the origin are still required.
    expect((await deleteAvatar(deleteRequest('https://foreign.example'), state.deps)).status).toBe(
      403,
    )
    state.deps.getSession = vi.fn(async () => null)
    expect((await deleteAvatar(deleteRequest(), state.deps)).status).toBe(401)
  })

  it('answers 503 to an upload and changes nothing when the consents cannot be checked', async () => {
    const state = setup(OLD_IMAGE)
    state.objects.set(OLD_KEY, imageBytes)
    const failure = new Error('database unavailable')
    state.deps.hasRequiredConsents = vi.fn(async () => {
      throw failure
    })
    expect((await uploadAvatar(upload(), state.deps)).status).toBe(503)
    expect(state.deps.onFailure).toHaveBeenCalledWith('avatar upload failed', failure)
    expect(state.deps.setUserImage).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
    // Removal does not ask for the consents, so their outage does not stop it.
    expect((await deleteAvatar(deleteRequest(), state.deps)).status).toBe(200)
    expect(state.objects.has(OLD_KEY)).toBe(false)
  })

  it('refuses an upload over the limit of the user before reading its body', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.admitUpload = vi.fn(async () => false)
    const request = upload()
    const res = await uploadAvatar(request, state.deps)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({
      message: 'Вы слишком часто загружаете фото. Попробуйте через несколько минут.',
    })
    expect(state.deps.admitUpload).toHaveBeenCalledWith(USER_ID)
    expect(request.bodyUsed).toBe(false)
    expect(state.deps.getUserImage).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
    expect(state.user.image).toBe(OLD_IMAGE)
  })

  it('counts uploads only: removal and reading stay outside the limit', async () => {
    const state = setup(OLD_IMAGE)
    state.objects.set(OLD_KEY, imageBytes)
    state.deps.admitUpload = vi.fn(async () => false)
    const read = await getAvatar(
      new Request(`${ORIGIN}${OLD_IMAGE}`),
      { userId: USER_ID, filename: OLD_FILENAME },
      state.deps,
    )
    expect(read.status).toBe(200)
    expect((await deleteAvatar(deleteRequest(), state.deps)).status).toBe(200)
    expect(state.deps.admitUpload).not.toHaveBeenCalled()
  })

  it('handles one upload of a user at a time and frees the user afterwards', async () => {
    const state = setup()
    let finishFirst!: () => void
    state.put.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        }),
    )
    const first = uploadAvatar(upload(), state.deps)
    await vi.waitFor(() => expect(state.put).toHaveBeenCalledTimes(1))

    const second = upload()
    const refused = await uploadAvatar(second, state.deps)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({
      message: 'Предыдущее фото ещё загружается. Дождитесь завершения.',
    })
    expect(second.bodyUsed).toBe(false)
    // A refused parallel request spends nothing of the limit.
    expect(state.deps.admitUpload).toHaveBeenCalledTimes(1)

    const other = setup()
    other.deps.getSession = vi.fn(async () => ({ user: { id: OTHER_USER_ID } }))
    expect((await uploadAvatar(upload(), other.deps)).status).toBe(200)

    finishFirst()
    expect((await first).status).toBe(200)
    expect((await uploadAvatar(upload(), state.deps)).status).toBe(200)
  })

  it('frees the user after a failed upload', async () => {
    const state = setup()
    state.put.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await uploadAvatar(upload(), state.deps)).status).toBe(503)
    state.deps.admitUpload = vi.fn(async () => {
      throw new Error('database unavailable')
    })
    expect((await uploadAvatar(upload(), state.deps)).status).toBe(503)
    state.deps.admitUpload = vi.fn(async () => true)
    expect((await uploadAvatar(upload(), state.deps)).status).toBe(200)
  })

  it('creates a versioned self URL and stores normalized pixels before changing the profile', async () => {
    const state = setup()
    const res = await uploadAvatar(upload(), state.deps)
    const { image } = (await res.json()) as { image: string }
    expect(res.status).toBe(200)
    expect(image).toMatch(new RegExp(`^/api/profile/avatar/${USER_ID}/[0-9a-f-]{36}\\.webp$`))
    expect(state.user.image).toBe(image)
    expect(state.put).toHaveBeenCalledWith(
      'artifacts',
      expect.stringContaining(`avatars/${USER_ID}/`),
      expect.any(Uint8Array),
      { contentType: 'image/webp', sizeBytes: expect.any(Number) },
    )
    expect(state.put.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(state.deps.setUserImage).mock.invocationCallOrder[0]!,
    )
    const saved = [...state.objects.values()][0]!
    expect((await sharp(saved).metadata()).format).toBe('webp')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('changes only the signed-in user and rejects a submitted foreign user id', async () => {
    const state = setup()
    const res = await uploadAvatar(
      upload({}, (form) => form.set('userId', OTHER_USER_ID)),
      state.deps,
    )
    expect(res.status).toBe(400)
    expect(state.deps.setUserImage).not.toHaveBeenCalled()
    expect(state.put).not.toHaveBeenCalled()
  })

  it('cleans the old owned object only after the new image is saved', async () => {
    const state = setup(OLD_IMAGE)
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(200)
    expect(state.remove).toHaveBeenCalledWith('artifacts', OLD_KEY)
    expect(state.remove.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(state.deps.setUserImage).mock.invocationCallOrder[0]!,
    )
  })

  it.each([
    'https://images.example/profile.png',
    `/api/profile/avatar/${OTHER_USER_ID}/${OLD_FILENAME}`,
    `/api/profile/avatar/${USER_ID}/../other.webp`,
    `${OLD_IMAGE}?other=1`,
  ])('never removes an external or unowned previous image: %s', async (image) => {
    const changed = setup(image)
    expect((await uploadAvatar(upload(), changed.deps)).status).toBe(200)
    expect(changed.remove).not.toHaveBeenCalled()
    const deleted = setup(image)
    expect((await deleteAvatar(deleteRequest(), deleted.deps)).status).toBe(200)
    expect(deleted.user.image).toBeNull()
    expect(deleted.remove).not.toHaveBeenCalled()
  })

  it('keeps the existing avatar when storing the new image fails', async () => {
    const state = setup(OLD_IMAGE)
    const failure = new Error('storage credentials must never reach the response')
    state.put.mockRejectedValueOnce(failure)
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('credentials')
    expect(state.user.image).toBe(OLD_IMAGE)
    expect(state.deps.setUserImage).not.toHaveBeenCalled()
    // The cause goes to the server log, never to the client.
    expect(state.deps.onFailure).toHaveBeenCalledWith('avatar upload failed', failure)
  })

  it('removes only its new object after a database failure', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.setUserImage = vi.fn(async () => {
      throw new Error('database unavailable')
    })
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(503)
    expect(state.user.image).toBe(OLD_IMAGE)
    expect(state.remove).toHaveBeenCalledTimes(1)
    expect(state.remove.mock.calls[0]?.[1]).not.toBe(OLD_KEY)
    expect(state.objects.size).toBe(0)
  })

  it('cleans a conflicting upload without removing the winner', async () => {
    const state = setup(OLD_IMAGE)
    const winner = `/api/profile/avatar/${USER_ID}/1762138e-4560-4b1c-9072-a42ff7310362.webp`
    state.deps.setUserImage = vi.fn(async () => {
      state.user.image = winner
      return false
    })
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(409)
    expect(state.user.image).toBe(winner)
    expect(state.remove).toHaveBeenCalledTimes(1)
    expect(state.remove.mock.calls[0]?.[1]).not.toBe(OLD_KEY)
  })

  it('keeps the saved object when a database response fails after the update committed', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.setUserImage = vi.fn(async (_id, _previous, image) => {
      state.user.image = image
      throw new Error('connection failed after commit')
    })
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ image: state.user.image })
    expect(state.remove).toHaveBeenCalledTimes(1)
    expect(state.remove).toHaveBeenCalledWith('artifacts', OLD_KEY)
    expect(state.objects.size).toBe(1)
  })

  it('retains the new object when database commit status cannot be established', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.setUserImage = vi.fn(async () => {
      throw new Error('database unavailable')
    })
    state.deps.getUserImage = vi
      .fn()
      .mockResolvedValueOnce({ image: OLD_IMAGE })
      .mockRejectedValueOnce(new Error('database remains unavailable'))
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(503)
    expect(state.remove).not.toHaveBeenCalled()
    expect(state.objects.size).toBe(1)
  })

  it('does not undo a saved photo when orphan cleanup fails', async () => {
    const state = setup(OLD_IMAGE)
    const failure = new Error('object cleanup unavailable')
    state.remove.mockRejectedValueOnce(failure)
    const res = await uploadAvatar(upload(), state.deps)
    expect(res.status).toBe(200)
    expect(state.user.image).not.toBe(OLD_IMAGE)
    expect(state.deps.onFailure).toHaveBeenCalledWith('avatar object cleanup failed', failure)
  })

  it('removes an owned avatar and repeated deletion is harmless', async () => {
    const state = setup(OLD_IMAGE)
    const res = await deleteAvatar(deleteRequest(), state.deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ image: null })
    expect(state.user.image).toBeNull()
    expect(state.remove).toHaveBeenCalledWith('artifacts', OLD_KEY)
    expect((await deleteAvatar(deleteRequest(), state.deps)).status).toBe(200)
    expect(state.remove).toHaveBeenCalledTimes(1)
  })

  it('reports a failed removal with its cause and its own message', async () => {
    const state = setup(OLD_IMAGE)
    const failure = new Error('database unavailable')
    state.deps.setUserImage = vi.fn(async () => {
      throw failure
    })
    const res = await deleteAvatar(deleteRequest(), state.deps)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ message: 'Не удалось удалить аватар. Попробуйте ещё раз.' })
    expect(state.deps.onFailure).toHaveBeenCalledWith('avatar removal failed', failure)
  })

  it('keeps a concurrently changed avatar when deletion loses the comparison', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.setUserImage = vi.fn(async () => false)
    expect((await deleteAvatar(deleteRequest(), state.deps)).status).toBe(409)
    expect(state.remove).not.toHaveBeenCalled()
  })

  it('refuses an oversized Content-Length without reading its body', async () => {
    const state = setup()
    const request = upload({ 'content-length': String(MAX_AVATAR_REQUEST_BYTES + 1) })
    expect((await uploadAvatar(request, state.deps)).status).toBe(413)
    expect(request.bodyUsed).toBe(false)
    expect(state.put).not.toHaveBeenCalled()
  })

  it('stops an oversized chunked request without buffering the remaining stream', async () => {
    const state = setup()
    let cancelled = false
    const request = new Request(`${ORIGIN}/api/profile/avatar`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=avatar' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024))
        },
        cancel() {
          cancelled = true
        },
      }),
      duplex: 'half',
    } as RequestInit)
    expect((await uploadAvatar(request, state.deps)).status).toBe(413)
    expect(cancelled).toBe(true)
    expect(state.put).not.toHaveBeenCalled()
  })
})

describe('avatar serving', () => {
  it('serves only the current image to its owner with private raster headers', async () => {
    const state = setup(OLD_IMAGE)
    state.objects.set(OLD_KEY, imageBytes)
    const res = await getAvatar(
      new Request(`${ORIGIN}${OLD_IMAGE}`),
      { userId: USER_ID, filename: OLD_FILENAME },
      state.deps,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    // The address is versioned: the owner's browser keeps its copy instead of asking each page.
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400, immutable')
    expect(res.headers.get('etag')).toBe(`"${OLD_FILENAME.slice(0, -5)}"`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(state.get).toHaveBeenCalledWith('artifacts', OLD_KEY)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(imageBytes)
    // Showing a stored photo is not a new write: the consent check guards mutations only.
    expect(state.deps.hasRequiredConsents).not.toHaveBeenCalled()
  })

  it('revalidates a kept copy without reading S3, and only for the owner of the current image', async () => {
    const state = setup(OLD_IMAGE)
    state.objects.set(OLD_KEY, imageBytes)
    const request = (weak = '') =>
      new Request(`${ORIGIN}${OLD_IMAGE}`, {
        headers: { 'if-none-match': `${weak}"${OLD_FILENAME.slice(0, -5)}"` },
      })
    const params = { userId: USER_ID, filename: OLD_FILENAME }

    const res = await getAvatar(request(), params, state.deps)
    expect(res.status).toBe(304)
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400, immutable')
    expect(await res.text()).toBe('')
    expect((await getAvatar(request('W/'), params, state.deps)).status).toBe(304)
    expect(state.get).not.toHaveBeenCalled()

    state.user.image = null
    expect((await getAvatar(request(), params, state.deps)).status).toBe(404)
    state.user.image = OLD_IMAGE
    state.deps.getSession = vi.fn(async () => null)
    const signedOut = await getAvatar(request(), params, state.deps)
    expect(signedOut.status).toBe(401)
    expect(signedOut.headers.get('cache-control')).toBe('no-store')
    expect(state.get).not.toHaveBeenCalled()
  })

  it('reports a failed read with its cause and does not call it a failed save', async () => {
    const state = setup(OLD_IMAGE)
    const failure = new Error('bucket access denied')
    state.get.mockRejectedValueOnce(failure)
    const res = await getAvatar(
      new Request(`${ORIGIN}${OLD_IMAGE}`),
      { userId: USER_ID, filename: OLD_FILENAME },
      state.deps,
    )
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ message: 'Не удалось загрузить аватар.' })
    expect(state.deps.onFailure).toHaveBeenCalledWith('avatar read failed', failure)
  })

  it('refuses unauthenticated, foreign, stale and malformed image URLs before fetching S3', async () => {
    const state = setup(OLD_IMAGE)
    state.deps.getSession = vi.fn(async () => null)
    const request = new Request(`${ORIGIN}${OLD_IMAGE}`)
    expect(
      (await getAvatar(request, { userId: USER_ID, filename: OLD_FILENAME }, state.deps)).status,
    ).toBe(401)
    state.deps.getSession = vi.fn(async () => ({ user: { id: USER_ID } }))
    for (const params of [
      { userId: OTHER_USER_ID, filename: OLD_FILENAME },
      { userId: USER_ID, filename: '1762138e-4560-4b1c-9072-a42ff7310362.webp' },
      { userId: USER_ID, filename: '../secret.webp' },
    ])
      expect((await getAvatar(request, params, state.deps)).status).toBe(404)
    expect(state.get).not.toHaveBeenCalled()
  })
})
