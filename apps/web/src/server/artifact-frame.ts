import 'server-only'

import type { PrismaClient } from '@repo/db'
import { pageFileHeaders } from '@repo/domain'
import {
  artifactEditFrameHeaders,
  artifactFileHeaders,
  artifactFrameHeaders,
  artifactPlatformFileHeaders,
  readArtifactPlatformToken,
} from '@repo/domain/artifacts'
import {
  isArtifactFileToken,
  isArtifactFrameToken,
  readArtifactEditViewer,
  serveArtifactFile,
  serveArtifactFrame,
  type ChatContext,
} from '@repo/trpc'

import { artifactPlatformFileOf, artifactPlatformFonts } from './artifact-platform'
import { pageAnswer } from './page-response'

// The answers of artifacts (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28; slices 88.12 and 88.13).
// On the root of the domain of pages, `/v/<segment>`: a file of the platform (`lib-….<hash>`), a
// file of an artifact by its signed address, the frame of a screen — each with the headers of its
// own sort. On the origin of the cabinet, `/api/artifact-frame/<token>`: the edit frame, which runs
// no script, answered only to a frame of the cabinet itself.

export interface ArtifactFrameDependencies {
  db: () => PrismaClient
  chat: () => ChatContext | null
  /** The host of the domain of pages; null — off. */
  pagesHost: () => string | null
  /** The session of the cabinet: the edit frame answers only the viewer its token names. */
  getSession?: (headers: Headers) => Promise<{ user: { id: string } } | null>
  now?: () => number
  onFailure?: (operation: string, error: unknown) => void
}

const hostOf = (request: Request) =>
  (request.headers.get('host')?.toLowerCase() ?? '').replace(/:(?:443|80)$/, '')

const bodyOf = (bytes: Uint8Array) => new Uint8Array(bytes) as Uint8Array<ArrayBuffer>

/**
 * An answer of an artifact on `/v/<segment>`; null — the segment is not one of artifacts (a page of
 * a chat of plan 67 answers it).
 */
export async function artifactOnPages(
  request: Request,
  segment: string,
  deps: ArtifactFrameDependencies,
): Promise<Response | null> {
  const now = (deps.now ?? Date.now)()
  const platform = readArtifactPlatformToken(segment)
  const chat = deps.chat()
  const file = platform === null && isArtifactFileToken(chat, segment, now)
  const frame = platform === null && !file && isArtifactFrameToken(chat, segment, now)
  // Not a segment of artifacts (an expired token of one is still one: 410).
  if (platform === null && !file && !frame) return null
  const pagesHost = deps.pagesHost()
  if (pagesHost === null || hostOf(request) !== pagesHost) return pageAnswer(404, 'Не найдено')
  try {
    if (platform !== null) {
      const found = artifactPlatformFileOf(platform.label, platform.hash)
      if (found === null) return pageAnswer(404, 'Не найдено')
      return new Response(bodyOf(found.bytes), {
        headers: {
          ...artifactPlatformFileHeaders(found.type),
          'Content-Length': String(found.bytes.byteLength),
        },
      })
    }
    if (file) {
      const served = await serveArtifactFile(deps.db(), chat, { token: segment }, now)
      if (!served.ok)
        return pageAnswer(served.status, served.status === 410 ? 'Адрес устарел.' : 'Не найдено')
      return new Response(bodyOf(served.bytes), {
        headers: {
          ...artifactFileHeaders(pageFileHeaders(served.type)),
          'Content-Length': String(served.bytes.byteLength),
        },
      })
    }
    const served = await serveArtifactFrame(
      deps.db(),
      chat,
      { token: segment, mode: 'view', fonts: artifactPlatformFonts(chat!.pageViews!.origin) },
      now,
    )
    if (!served.ok)
      return pageAnswer(
        served.status,
        served.status === 410 ? 'Адрес устарел. Обновите страницу.' : 'Не найдено',
      )
    const bytes = new TextEncoder().encode(served.html)
    return new Response(bytes, {
      headers: {
        ...artifactFrameHeaders(served.appOrigin, served.sources),
        'Content-Length': String(bytes.byteLength),
      },
    })
  } catch (error) {
    deps.onFailure?.('artifact on pages failed', error)
    return pageAnswer(503, 'Не удалось открыть экран.')
  }
}

/**
 * `GET /api/artifact-frame/<token>`: the edit frame (Ар9). Only a frame of the cabinet's own origin
 * asks for it (`Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: same-origin`); opened as a tab it would
 * run nothing either, but then both lines left would sit in one header.
 */
export async function artifactEditFrame(
  request: Request,
  token: string,
  deps: ArtifactFrameDependencies,
): Promise<Response> {
  if (
    request.headers.get('sec-fetch-dest') !== 'iframe' ||
    request.headers.get('sec-fetch-site') !== 'same-origin'
  )
    return pageAnswer(404, 'Не найдено')
  try {
    const chat = deps.chat()
    if (!chat?.pageViews) return pageAnswer(404, 'Не найдено')
    const pagesOrigin = chat.pageViews.origin
    if (deps.getSession) {
      const session = await deps.getSession(request.headers)
      const named = readArtifactEditViewer(chat, token, (deps.now ?? Date.now)())
      if (session === null || named !== session.user.id) return pageAnswer(404, 'Не найдено')
    }
    const served = await serveArtifactFrame(
      deps.db(),
      chat,
      { token, mode: 'edit', fonts: artifactPlatformFonts(pagesOrigin) },
      (deps.now ?? Date.now)(),
    )
    if (!served.ok)
      return pageAnswer(
        served.status,
        served.status === 410 ? 'Адрес устарел. Обновите страницу.' : 'Не найдено',
      )
    const bytes = new TextEncoder().encode(served.html)
    return new Response(bytes, {
      headers: {
        ...artifactEditFrameHeaders(pagesOrigin),
        'Content-Length': String(bytes.byteLength),
      },
    })
  } catch (error) {
    deps.onFailure?.('artifact edit frame failed', error)
    return pageAnswer(503, 'Не удалось открыть экран.')
  }
}
