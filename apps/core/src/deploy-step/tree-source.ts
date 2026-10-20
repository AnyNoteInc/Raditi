import { createHash } from 'node:crypto'

import { publicationLimits } from '@repo/domain'

import type { RunFacts } from './run-facts.ts'

// The files of the approved commit as the deploy job reads them: the raw file API of the site's
// own Gitea (`GET /api/v1/repos/<repo>/raw/<path>?ref=<sha>`) with the job token, which reads its
// own repository and nothing else (`permissions: contents: read`, measured by the pipeline stand).
// There is no `uses:` in the workflow, so no checkout action: the job fetches exactly the files it
// writes. Each must be the size and the SHA-256 the manifest names — core's word, not the network's.

export class TreeSourceError extends Error {
  constructor() {
    super('A file of the approved commit could not be read as the manifest names it')
    this.name = 'TreeSourceError'
  }
}

export interface TreeSource {
  file(path: string, expected: { sha256: string; sizeBytes: number }): Promise<Uint8Array>
}

export function createTreeSource(options: {
  run: RunFacts
  /** `gitea.token` of the job. */
  token: string
  fetch?: typeof fetch
  timeoutMs?: number
}): TreeSource {
  const send = options.fetch ?? fetch
  const base = new URL(options.run.server)
  const [owner, name] = options.run.repository.split('/') as [string, string]
  return {
    async file(path, expected) {
      if (expected.sizeBytes > publicationLimits.fileBytes) throw new TreeSourceError()
      const url = new URL(base)
      url.pathname = [
        base.pathname.replace(/\/+$/, ''),
        'api/v1/repos',
        encodeURIComponent(owner),
        encodeURIComponent(name),
        'raw',
        ...path.split('/').map(encodeURIComponent),
      ].join('/')
      url.search = new URLSearchParams({ ref: options.run.sha }).toString()
      let response: Response
      try {
        response = await send(url, {
          headers: { authorization: `token ${options.token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        })
      } catch {
        throw new TreeSourceError()
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => {})
        throw new TreeSourceError()
      }
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > expected.sizeBytes) {
          await response.body.cancel().catch(() => {})
          throw new TreeSourceError()
        }
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks, size)
      if (
        size !== expected.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== expected.sha256
      )
        throw new TreeSourceError()
      return bytes
    },
  }
}
