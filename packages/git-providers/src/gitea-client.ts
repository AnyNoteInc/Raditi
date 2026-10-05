import { Buffer } from 'node:buffer'

import { badRequest, DomainError } from '@repo/domain'
import { z } from 'zod'

import type { GitProviderConfig } from './config.ts'

export interface GiteaClientOptions {
  /** Tests inject one; the process-wide fetch trusts the CA from NODE_EXTRA_CA_CERTS. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface GiteaRepository {
  owner: string
  name: string
  defaultBranch: string
  private: boolean
}
export interface GiteaToken {
  id: number
  name: string
  scopes: string[]
  token: string
}

/** The two methods of P8 that a turn needs, plus the token calls behind short-lived grants. */
export interface GiteaClient {
  /** The web root without a trailing slash: repositories are cloned from below it. */
  readonly root: string
  getRepository(owner: string, name: string): Promise<GiteaRepository | null>
  /** Login of the account the bot token belongs to. */
  tokenOwner(): Promise<string>
  createToken(login: string, name: string, scopes: readonly string[]): Promise<GiteaToken>
  listTokens(login: string, page: number): Promise<{ id: number; name: string }[]>
  /** A token that is already gone counts as deleted. */
  deleteToken(login: string, id: number): Promise<void>
}

/** Messages never carry the token, the address or a response body. */
export const giteaFailed = (message: string): DomainError =>
  new DomainError('GIT_PROVIDER_FAILED', message, 502)
const notConfigured = (): DomainError =>
  new DomainError(
    'GIT_PROVIDER_NOT_CONFIGURED',
    'Gitea API needs an https:// address and a bot token',
    503,
  )

/** MAX_RESPONSE_ITEMS of Gitea by default; a smaller server limit only shortens the pages. */
export const GITEA_PAGE_SIZE = 50
/** A repository answer is about 3 KiB, a page of 50 tokens about 12 KiB. */
const RESPONSE_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

const slug = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)
/** An owner, repository or login that is safe as one URL path segment. */
export const isGiteaName = (value: unknown): value is string => slug.safeParse(value).success
const printable = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[\x21-\x7e]+$/)
const tokenId = z.number().int().positive()
const repositorySchema = z.object({
  name: slug,
  owner: z.object({ login: slug }),
  default_branch: printable(255),
  private: z.boolean(),
})
const currentTokenSchema = z.object({ user: z.object({ login: slug }) })
const createdTokenSchema = z.object({
  id: tokenId,
  name: printable(255),
  scopes: z.array(printable(100)).max(100),
  // 40 hex characters in 1.27.3; the alphabet leaves room for a prefixed format.
  sha1: z.string().regex(/^[A-Za-z0-9_-]{20,255}$/),
})
const tokenListSchema = z
  .array(z.object({ id: tokenId, name: z.string().max(255) }))
  .max(GITEA_PAGE_SIZE)

interface Send {
  method: 'GET' | 'POST' | 'DELETE'
  /** Token endpoints of Gitea accept Basic only; the bot token serves as the password. */
  basicLogin?: string
  body?: object
}

/**
 * REST client of our Gitea (spec §10), HTTPS only: every request carries the bot token.
 * Redirects are not followed, so a renamed repository is an error and not another repository.
 */
export function createGiteaClient(
  config: GitProviderConfig,
  options: GiteaClientOptions = {},
): GiteaClient {
  const root = apiRoot(config.baseUrl)
  if (!root || !printable(4096).safeParse(config.token).success) throw notConfigured()
  const { token } = config
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(path: string, request: Send): Promise<Response> {
    try {
      return await fetchImpl(`${root}/api/v1${path}`, {
        method: request.method,
        headers: {
          accept: 'application/json',
          authorization:
            request.basicLogin === undefined
              ? `token ${token}`
              : `Basic ${Buffer.from(`${request.basicLogin}:${token}`).toString('base64')}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // A network or parser error may quote the request, its headers included.
      throw giteaFailed('Gitea request failed')
    }
  }

  /** The parsed body of the one expected status; `missing` maps 404 to null. */
  async function read<T>(
    what: string,
    response: Response,
    expected: number,
    schema: z.ZodType<T>,
    missing = false,
  ): Promise<T | null> {
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => undefined)
      if (missing && response.status === 404) return null
      throw giteaFailed(`Gitea ${what} returned HTTP ${response.status}`)
    }
    const parsed = schema.safeParse(await json(response))
    if (!parsed.success) throw giteaFailed(`Unexpected Gitea ${what} response`)
    return parsed.data
  }
  const user = (login: string) => {
    if (!isGiteaName(login)) throw badRequest('Invalid Gitea login')
    return `/users/${login}/tokens`
  }

  return {
    root,
    async getRepository(owner, name) {
      if (!isGiteaName(owner) || !isGiteaName(name))
        throw badRequest('Invalid repository reference')
      const response = await send(`/repos/${owner}/${name}`, { method: 'GET' })
      const repository = await read('repository lookup', response, 200, repositorySchema, true)
      return (
        repository && {
          owner: repository.owner.login,
          name: repository.name,
          defaultBranch: repository.default_branch,
          private: repository.private,
        }
      )
    },
    async tokenOwner() {
      const response = await send('/token', { method: 'GET' })
      return (await read('token lookup', response, 200, currentTokenSchema))!.user.login
    },
    async createToken(login, name, scopes) {
      const response = await send(user(login), {
        method: 'POST',
        basicLogin: login,
        body: { name, scopes },
      })
      const created = (await read('token creation', response, 201, createdTokenSchema))!
      return { id: created.id, name: created.name, scopes: created.scopes, token: created.sha1 }
    },
    async listTokens(login, page) {
      if (!Number.isSafeInteger(page) || page < 1) throw badRequest('Invalid token page')
      const response = await send(`${user(login)}?page=${page}&limit=${GITEA_PAGE_SIZE}`, {
        method: 'GET',
        basicLogin: login,
      })
      return (await read('token list', response, 200, tokenListSchema))!
    },
    async deleteToken(login, id) {
      if (!tokenId.safeParse(id).success) throw badRequest('Invalid token id')
      const response = await send(`${user(login)}/${id}`, { method: 'DELETE', basicLogin: login })
      await response.body?.cancel().catch(() => undefined)
      if (response.status !== 204 && response.status !== 404)
        throw giteaFailed(`Gitea token deletion returned HTTP ${response.status}`)
    },
  }
}

/** The HTTPS web root without a trailing slash, or null when the API must not be called. */
function apiRoot(baseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

async function json(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    if (!response.body) throw new Error('empty')
    // Leaving the loop early cancels the stream.
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > RESPONSE_BYTES) throw new Error('too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw giteaFailed('Unexpected Gitea response body')
  }
}
