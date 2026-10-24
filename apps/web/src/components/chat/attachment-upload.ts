import {
  attachmentLimits,
  attachmentTypeByName,
  type AttachmentRefusal,
} from '@repo/domain/attachments/rules'
import { attachmentRefusalText } from '@repo/domain/attachments/labels'

// How the cabinet sends the bytes of an attached file (docs/plan/57-browser-tasks.md, Б26):
// `attachment.start` announces it, then one PUT of the bytes to the path it answered — through
// web, never to S3 directly. An XMLHttpRequest, not fetch: only it reports the progress of an
// upload.

/** What the server answered for a file it took. */
export interface UploadedFile {
  attachmentId: string
  size: number
}

export class UploadFailure extends Error {
  /** The HTTP status; 0 — no answer arrived. */
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Said when no answer arrived: the network failed, not the file. */
export const UPLOAD_OFFLINE_TEXT =
  'Не удалось отправить файл. Проверьте подключение и попробуйте ещё раз.'

/**
 * Why a file would be refused before anything is sent: the rules of the domain the server
 * checks again. null — the file may be announced.
 */
export function localRefusal(file: { name: string; size: number }): AttachmentRefusal | null {
  if (file.size === 0) return 'empty'
  if (attachmentTypeByName(file.name) === null) return 'type_not_allowed'
  if (file.size > attachmentLimits.fileBytes) return 'too_large'
  return null
}

export const localRefusalText = (refusal: AttachmentRefusal): string =>
  attachmentRefusalText[refusal]

/** The words of a refusal the route answered, or a sentence for a failure without them. */
function messageOf(request: XMLHttpRequest): string {
  try {
    const body = JSON.parse(request.responseText) as { message?: unknown }
    if (typeof body.message === 'string' && body.message.trim() !== '') return body.message
  } catch {
    // Not the route's answer: a proxy or the network.
  }
  return request.status === 0
    ? UPLOAD_OFFLINE_TEXT
    : 'Не удалось загрузить файл. Попробуйте ещё раз.'
}

export type UploadBytes = (
  path: string,
  file: Blob,
  options: { onProgress: (fraction: number) => void; signal: AbortSignal },
) => Promise<UploadedFile>

/** One PUT of the bytes of an announced file, with its progress from 0 to 1. */
export const uploadBytes: UploadBytes = (path, file, { onProgress, signal }) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', path)
    request.responseType = 'text'
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      if (request.status === 200) {
        try {
          resolve(JSON.parse(request.responseText) as UploadedFile)
        } catch {
          reject(new UploadFailure(messageOf(request), request.status))
        }
      } else reject(new UploadFailure(messageOf(request), request.status))
    }
    request.onerror = () => reject(new UploadFailure(UPLOAD_OFFLINE_TEXT, 0))
    request.onabort = () => reject(new DOMException('The upload was cancelled', 'AbortError'))
    signal.addEventListener('abort', () => request.abort(), { once: true })
    request.send(file)
  })
