import 'server-only'

import sharp from 'sharp'
import { z } from 'zod'

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024
export const MAX_AVATAR_PIXELS = 24_000_000
export const AVATAR_SIDE = 512
export const AVATAR_CONTENT_TYPE = 'image/webp'
export const MAX_STORED_AVATAR_BYTES = 1024 * 1024
/** Uploads that may wait for the decoder; each one holds its file of up to 5 MiB. */
export const MAX_WAITING_AVATARS = 4

// One libvips thread per image, process-wide: a decode must not take every core of the server.
sharp.concurrency(1)

const imageTypes = ['image/jpeg', 'image/png', 'image/webp'] as const
const fileSchema = z.file()

/** A public message with its HTTP status; image decoder details never leave the server. */
export class AvatarError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AvatarError'
    this.status = status
  }
}

/** Both the claimed MIME and the bytes must be an allowed raster format. */
function sniffMime(bytes: Uint8Array): (typeof imageTypes)[number] | null {
  const startsWith = (prefix: number[], offset = 0) =>
    bytes.length >= offset + prefix.length && prefix.every((byte, i) => bytes[offset + i] === byte)

  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  return null
}

let decoding = false
const waiting: (() => void)[] = []

/**
 * One decode at a time in this process: a frame of MAX_AVATAR_PIXELS takes about 100 MB and a
 * libuv thread that DNS, file and compression work of the server share. A full queue refuses.
 */
async function decodeInTurn<T>(decode: () => Promise<T>): Promise<T> {
  if (decoding) {
    if (waiting.length >= MAX_WAITING_AVATARS)
      throw new AvatarError(503, 'Сейчас загружается много фото. Попробуйте через минуту.')
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  decoding = true
  try {
    return await decode()
  } finally {
    // Hand the slot straight to the next upload, so a newcomer cannot overtake the queue.
    const next = waiting.shift()
    if (next) next()
    else decoding = false
  }
}

/** Decodes every pixel, strips metadata, applies EXIF rotation and produces a bounded WebP. */
export async function normalizeAvatar(value: unknown): Promise<Uint8Array> {
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success) throw new AvatarError(400, 'Выберите файл изображения.')
  const file = parsed.data
  if (file.size === 0) throw new AvatarError(400, 'Файл изображения пуст.')
  if (file.size > MAX_AVATAR_BYTES)
    throw new AvatarError(413, 'Изображение должно быть не больше 5 МБ.')
  if (!(imageTypes as readonly string[]).includes(file.type))
    throw new AvatarError(415, 'Поддерживаются изображения JPEG, PNG и WebP.')

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (sniffMime(bytes) !== file.type)
    throw new AvatarError(415, 'Содержимое файла не соответствует формату изображения.')

  return decodeInTurn(async () => {
    try {
      // Truncated and corrupt data fail; a decoder warning does not: cameras write files that
      // open everywhere with one, and every pixel is re-encoded anyway.
      const image = sharp(bytes, {
        failOn: 'error',
        limitInputPixels: MAX_AVATAR_PIXELS,
        sequentialRead: true,
      }).timeout({ seconds: 10 })
      const metadata = await image.metadata()
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > MAX_AVATAR_PIXELS ||
        !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')
      ) {
        throw new AvatarError(400, 'Изображение слишком большое или повреждено.')
      }
      if ((metadata.pages ?? 1) > 1)
        throw new AvatarError(400, 'Выберите статичное изображение без анимации.')

      const normalized = await image
        .rotate()
        .resize(AVATAR_SIDE, AVATAR_SIDE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer()
      if (normalized.byteLength > MAX_STORED_AVATAR_BYTES)
        throw new AvatarError(400, 'Не удалось подготовить изображение. Выберите другой файл.')
      return new Uint8Array(normalized)
    } catch (error) {
      if (error instanceof AvatarError) throw error
      throw new AvatarError(400, 'Не удалось прочитать изображение. Проверьте файл.')
    }
  })
}
