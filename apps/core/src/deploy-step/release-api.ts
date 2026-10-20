import {
  deployAccessSchema,
  deployManifestSchema,
  RELEASE_API_HEALTH_PATH,
  releaseApiPaths,
  releaseBackupAnswerSchema,
  releasePresignedSchema,
  releaseReportKey,
  releaseStepAnswerSchema,
  type DeployAccess,
  type DeployManifest,
  type ReleasePresigned,
  type ReleaseStep,
  type ReleaseStepAnswer,
  type ReleaseStepDetail,
  type ReleaseStepState,
} from '@repo/domain'
import type { z } from 'zod'

// The client of the release API of core (Р32) as the deploy job uses it: one bearer token of this
// attempt, JSON in and out, every answer checked by its schema. A report is idempotent by its
// key, so a request without an answer is sent again; a refusal (4xx) is final. Nothing of what
// core answers is printed.

/** Fixed text: a failed call never carries what core or the network said. */
export class ReleaseApiError extends Error {
  /** HTTP status of a final refusal; null — no usable answer. */
  readonly status: number | null

  constructor(status: number | null) {
    super(
      status === null ? 'The release API did not answer' : `The release API refused (${status})`,
    )
    this.name = 'ReleaseApiError'
    this.status = status
  }
}

export interface ReleaseApi {
  manifest(): Promise<DeployManifest>
  /** Once per attempt, after the first report (Р29). */
  access(): Promise<DeployAccess>
  report(
    step: ReleaseStep,
    state: ReleaseStepState,
    detail?: ReleaseStepDetail,
  ): Promise<ReleaseStepAnswer>
  backupPut(facts: { sha256: string; sizeBytes: number }): Promise<ReleasePresigned>
  backupVerify(facts: { sha256: string; sizeBytes: number }): Promise<boolean>
}

export interface ReleaseApiOptions {
  /** `RADITI_RELEASE_API_URL` of the runner: an http(s) origin. */
  baseUrl: string
  releaseId: string
  deployAttempt: number
  token: string
  fetch?: typeof fetch
  /** Waits between the tries of one request, in ms; their count is the number of retries. */
  backoffMs?: readonly number[]
  /**
   * The same for the manifest — the first call after the wrapping was spent: core restarting
   * meanwhile must not cost the attempt.
   */
  manifestBackoffMs?: readonly number[]
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** A manifest of 10 000 files with their hashes stays far below this. */
const RESPONSE_MAX_BYTES = 16 * 1024 * 1024

export function releaseApiOrigin(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error('The release API address is not an origin')
  return url.origin
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) {
      await response.body.cancel().catch(() => {})
      throw new ReleaseApiError(null)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function createReleaseApi(options: ReleaseApiOptions): ReleaseApi {
  const origin = releaseApiOrigin(options.baseUrl)
  const send = options.fetch ?? fetch
  const backoff = options.backoffMs ?? [1_000, 2_000, 4_000, 8_000, 15_000]
  const manifestBackoff = options.manifestBackoffMs ?? [
    1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000,
  ]
  const timeoutMs = options.timeoutMs ?? 20_000
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const { releaseId, deployAttempt } = options

  async function call<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    pauses: readonly number[] = backoff,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let status: number | null = null
      try {
        const response = await send(`${origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${options.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
        status = response.status
        const raw = await readBounded(response, RESPONSE_MAX_BYTES)
        if (response.status >= 400 && response.status < 500 && response.status !== 429)
          throw new ReleaseApiError(response.status)
        if (response.status === 200) {
          const parsed = schema.safeParse(JSON.parse(Buffer.from(raw).toString('utf8')))
          if (parsed.success) return parsed.data
          // An answer of another shape is a fault of core, not of the network: final.
          throw new ReleaseApiError(response.status)
        }
      } catch (error) {
        if (error instanceof ReleaseApiError && error.status !== null) throw error
      }
      if (attempt >= pauses.length) throw new ReleaseApiError(status)
      await sleep(pauses[attempt]!)
    }
  }

  return {
    manifest: () =>
      call(releaseApiPaths.manifest(releaseId), undefined, deployManifestSchema, manifestBackoff),
    access: () => call(releaseApiPaths.access(releaseId), { deployAttempt }, deployAccessSchema),
    report: (step, state, detail = {}) =>
      call(
        releaseApiPaths.steps(releaseId),
        {
          reportKey: releaseReportKey(deployAttempt, step, state),
          deployAttempt,
          step,
          state,
          detail,
        },
        releaseStepAnswerSchema,
      ),
    async backupPut(facts) {
      const answer = await call(
        releaseApiPaths.backup(releaseId),
        { phase: 'put', deployAttempt, ...facts },
        releaseBackupAnswerSchema,
      )
      if (answer.phase !== 'put' || answer.put.method !== 'PUT') throw new ReleaseApiError(200)
      return answer.put
    },
    async backupVerify(facts) {
      const answer = await call(
        releaseApiPaths.backup(releaseId),
        { phase: 'verify', deployAttempt, ...facts },
        releaseBackupAnswerSchema,
      )
      if (answer.phase !== 'verify') throw new ReleaseApiError(200)
      return answer.verified
    },
  }
}

/**
 * Whether the release API answers its health check (no token): asked before the wrapping is
 * spent, again and again for `waitMs` — a restart of core costs the job a wait, not the attempt.
 */
export async function waitForReleaseApi(
  baseUrl: string,
  options: {
    fetch?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    waitMs?: number
    pauseMs?: number
  } = {},
): Promise<boolean> {
  const origin = releaseApiOrigin(baseUrl)
  const send = options.fetch ?? fetch
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const until = now() + (options.waitMs ?? 5 * 60_000)
  for (;;) {
    try {
      const response = await send(`${origin}${RELEASE_API_HEALTH_PATH}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      await response.body?.cancel().catch(() => {})
      if (response.status === 200) return true
    } catch {
      // Not yet.
    }
    if (now() >= until) return false
    await sleep(options.pauseMs ?? 10_000)
  }
}

/**
 * The time a transfer of `bytes` may take: a minute, plus a second per megabyte — a backup of
 * 512 MiB gets 10 minutes, at least 1 MB/s.
 */
export const transferTimeoutMs = (bytes: number): number => 60_000 + Math.ceil(bytes / 1_000)

/** A presigned request of the release API; its URL never leaves this function. */
export async function presignedTransfer(
  presigned: ReleasePresigned,
  options: { body?: Uint8Array; maxBytes: number; fetch?: typeof fetch; timeoutMs?: number },
): Promise<Uint8Array> {
  const request = releasePresignedSchema.parse(presigned)
  if ((request.method === 'PUT') !== (options.body !== undefined)) throw new ReleaseApiError(null)
  const send = options.fetch ?? fetch
  let response: Response
  try {
    response = await send(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(options.body === undefined ? {} : { body: Buffer.from(options.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(
        options.timeoutMs ?? transferTimeoutMs(options.body?.byteLength ?? options.maxBytes),
      ),
    })
  } catch {
    throw new ReleaseApiError(null)
  }
  const body = await readBounded(response, options.maxBytes)
  if (response.status < 200 || response.status > 299) throw new ReleaseApiError(response.status)
  return body
}
