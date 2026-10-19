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
  id: number
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
export interface GiteaTagProtection {
  id: number
  pattern: string
  users: string[]
  teams: string[]
}
export interface GiteaTag {
  name: string
  /** What the ref points to: the commit of a lightweight tag, the tag object otherwise. */
  id: string
  commitSha: string
}
/** A run of Gitea Actions as GET …/actions/runs answers it. */
export interface GiteaRun {
  id: number
  htmlUrl: string
  /** `deploy.yml@refs/tags/v1.2.0`; the REST run has no repository path of the file. */
  path: string | null
  event: string | null
  runAttempt: number | null
  headSha: string
  headBranch: string | null
  status: string
  conclusion: string | null
}
export interface GiteaRunFilter {
  headSha?: string
  event?: string
  branch?: string
}

/**
 * The methods of P8 that a turn and a release need, the token calls behind short-lived grants,
 * and the one call of the account that creates site repositories (gitea-repository-provisioner.ts).
 * A call that takes `ownerToken` is made as an owner of the organization (plan 53, Р35): Gitea
 * 1.27.3 lets nobody else touch the Actions secrets of a repository or its tag protection.
 */
export interface GiteaClient {
  /** The web root without a trailing slash: repositories are cloned from below it. */
  readonly root: string
  getRepository(owner: string, name: string): Promise<GiteaRepository | null>
  /**
   * Creates a private repository without a first commit, default branch `main`, as the account
   * of the token. Null when the organization already has that name (409): nothing was created.
   * A refusal by 401, 403 or 404 says which in its GiteaRefusal.
   */
  createOrganizationRepository(org: string, name: string): Promise<GiteaRepository | null>
  /** Login of the account the token belongs to: the bot's, or the owner's when given. */
  tokenOwner(ownerToken?: string): Promise<string>
  createToken(login: string, name: string, scopes: readonly string[]): Promise<GiteaToken>
  listTokens(login: string, page: number): Promise<{ id: number; name: string }[]>
  /** A token that is already gone counts as deleted. */
  deleteToken(login: string, id: number): Promise<void>
  /** Creates or replaces a secret of the repository's Actions (never of its organization). */
  setRepositorySecret(
    owner: string,
    name: string,
    secret: string,
    value: string,
    ownerToken: string,
  ): Promise<void>
  /** A secret that is already gone counts as deleted. */
  deleteRepositorySecret(
    owner: string,
    name: string,
    secret: string,
    ownerToken: string,
  ): Promise<void>
  listTagProtections(owner: string, name: string, ownerToken: string): Promise<GiteaTagProtection[]>
  /**
   * Null when Gitea refuses with 403: it answers so both to an account that may not and to a
   * pattern that is already protected (recorded 2026-10-17); the caller looks again.
   */
  createTagProtection(
    owner: string,
    name: string,
    rule: { pattern: string; users: string[] },
    ownerToken: string,
  ): Promise<GiteaTagProtection | null>
  editTagProtection(
    owner: string,
    name: string,
    id: number,
    rule: { pattern: string; users: string[] },
    ownerToken: string,
  ): Promise<GiteaTagProtection>
  /**
   * A lightweight tag on `target`, made as the account of `ownerToken`. Null when the name is
   * taken (409): Gitea never moves a tag through this call. A tag protected for another account
   * is refused (`forbidden`), a missing commit or repository too (`not_found`).
   */
  createTag(
    owner: string,
    name: string,
    tag: string,
    target: string,
    ownerToken: string,
  ): Promise<GiteaTag | null>
  getTag(owner: string, name: string, tag: string): Promise<GiteaTag | null>
  /** One page, newest first, with the count of every run the filter matches. */
  listRuns(
    owner: string,
    name: string,
    filter: GiteaRunFilter,
    page: number,
  ): Promise<{ total: number; runs: GiteaRun[] }>
  getRun(owner: string, name: string, id: number): Promise<GiteaRun | null>
  /**
   * workflow_dispatch of a workflow file of the repository, or of a scoped (required) workflow
   * when `sourceRepositoryId` names the repository it comes from. The id of the new run.
   */
  dispatchWorkflow(
    owner: string,
    name: string,
    workflow: string,
    request: { ref: string; inputs: Record<string, string> },
    sourceRepositoryId?: number,
  ): Promise<number>
}

/** Messages never carry the token, the address or a response body. */
export const giteaFailed = (message: string): DomainError =>
  new DomainError('GIT_PROVIDER_FAILED', message, 502)
/**
 * Why a refusal is final while the token, its account and the repository stay as they are: a
 * word of ours in `details.reason`, fit for a log line, never Gitea's. `invalid` — Gitea refused
 * the request itself (400, 409, 422: a name, a value or an account it does not take). A failure
 * without one got no usable answer (network, timeout, redirect, 5xx) and may pass on a retry.
 */
export type GiteaRefusal = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'not_ours'
export const giteaRefused = (reason: GiteaRefusal, message: string): DomainError =>
  new DomainError('GIT_PROVIDER_FAILED', message, 502, { reason })
const notConfigured = (): DomainError =>
  new DomainError(
    'GIT_PROVIDER_NOT_CONFIGURED',
    'Gitea API needs an https:// address and a bot token',
    503,
  )
/**
 * Gitea will not start this workflow (GitProvider.dispatchWorkflow): `no_trigger` — the file has
 * no workflow_dispatch trigger (422); `not_found` — no such file or ref, or a source of scoped
 * workflows that does not apply to the repository (404).
 */
export const giteaNotSupported = (reason: 'no_trigger' | 'not_found', message: string) =>
  new DomainError('NOT_SUPPORTED', message, 501, { reason })

/** MAX_RESPONSE_ITEMS of Gitea by default; a smaller server limit only shortens the pages. */
export const GITEA_PAGE_SIZE = 50
/**
 * A repository answer is about 3 KiB, a page of 50 tokens about 12 KiB, a page of 50 runs —
 * each with its actor and two repositories — about 380 KiB (recorded 2026-10-17: 7.6 KiB a run).
 */
const RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
/** A refused creation by its status: an unknown token; a missing scope or team right; no member. */
const creationRefusals = new Map<number, GiteaRefusal>([
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not_found'],
])
/** The release calls also take Gitea's refusal of the request itself as final. */
const finalRefusals = new Map<number, GiteaRefusal>([
  ...creationRefusals,
  [400, 'invalid'],
  [409, 'invalid'],
  [422, 'invalid'],
])

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
  id: z.number().int().positive(),
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
const sha = z.string().regex(/^[0-9a-f]{40}$/)
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048)
const tagProtectionSchema = z.object({
  id: tokenId,
  name_pattern: printable(255),
  whitelist_usernames: z.array(slug).max(100).nullish(),
  whitelist_teams: z.array(printable(255)).max(100).nullish(),
})
const tagSchema = z.object({
  name: printable(255),
  id: sha,
  commit: z.object({ sha }),
})
const runSchema = z.object({
  id: tokenId,
  html_url: httpUrl,
  path: z.string().min(1).max(1024).nullish(),
  event: z.string().min(1).max(64).nullish(),
  run_attempt: z.number().int().positive().max(1_000_000).nullish(),
  head_sha: sha,
  // Gitea leaves out an empty field: a tag push has no head_branch.
  head_branch: z.string().min(1).max(255).nullish(),
  status: z.string().min(1).max(64),
  conclusion: z.string().max(64).nullish(),
})
const runPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(runSchema).max(GITEA_PAGE_SIZE),
})
const dispatchedSchema = z.object({ workflow_run_id: tokenId })
/** Secret names as Gitea 1.27.3 stores them (it upper-cases); its own prefixes are refused. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const RESERVED_SECRET_PREFIX = /^(GITEA|GITHUB)_/
/** Gitea 1.27.3 took 65 536 bytes and answered «data too long» to one more (2026-10-17). */
export const GITEA_SECRET_MAX_BYTES = 65_536
/** A glob of tag names; Gitea's `/regex/` form is not used. */
const TAG_PATTERN = /^[A-Za-z0-9._*-]{1,64}$/
export const isGiteaTagPattern = (value: unknown): value is string =>
  typeof value === 'string' && TAG_PATTERN.test(value)
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const isTagName = (tag: string) => TAG_NAME.test(tag) && !tag.includes('..')
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/
const DISPATCH_REF = /^(?:refs\/(?:heads|tags)\/)?[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const MAX_INPUTS = 10
const MAX_INPUT_BYTES = 1024
const EVENT = /^[a-z_]{1,64}$/

interface Send {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Token endpoints of Gitea accept Basic only; the bot token serves as the password. */
  basicLogin?: string
  /** Sent instead of the bot token: a call only an owner of the organization may make. */
  token?: string
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
    if (request.token !== undefined && !printable(4096).safeParse(request.token).success)
      throw notConfigured()
    try {
      return await fetchImpl(`${root}/api/v1${path}`, {
        method: request.method,
        headers: {
          accept: 'application/json',
          authorization:
            request.basicLogin === undefined
              ? `token ${request.token ?? token}`
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

  /**
   * The parsed body of the one expected status; `missing` maps 404 to null. With `final`, a
   * refusal says why (GiteaRefusal), as the release calls need: their callers stop on it.
   */
  async function read<T>(
    what: string,
    response: Response,
    expected: number,
    schema: z.ZodType<T>,
    { missing = false, final = false } = {},
  ): Promise<T | null> {
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => undefined)
      if (missing && response.status === 404) return null
      if (final) throw refused(what, response.status)
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
  const repo = (owner: string, name: string) => {
    if (!isGiteaName(owner) || !isGiteaName(name)) throw badRequest('Invalid repository reference')
    return `/repos/${owner}/${name}`
  }
  /** Drops the body of an answer whose status alone is the answer. */
  const status = async (response: Response) => {
    await response.body?.cancel().catch(() => undefined)
    return response.status
  }
  function refused(what: string, code: number): DomainError {
    const reason = finalRefusals.get(code)
    return reason
      ? giteaRefused(reason, `Gitea ${what} returned HTTP ${code}`)
      : giteaFailed(`Gitea ${what} returned HTTP ${code}`)
  }
  const secretPath = (owner: string, name: string, secret: string) => {
    if (!SECRET_NAME.test(secret) || RESERVED_SECRET_PREFIX.test(secret))
      throw badRequest('Invalid Actions secret name')
    return `${repo(owner, name)}/actions/secrets/${secret}`
  }
  const tagRule = (rule: { pattern: string; users: string[] }) => {
    if (
      !isGiteaTagPattern(rule.pattern) ||
      !Array.isArray(rule.users) ||
      rule.users.length === 0 ||
      rule.users.length > 100 ||
      !rule.users.every(isGiteaName)
    )
      throw badRequest('Invalid tag protection')
    return { name_pattern: rule.pattern, whitelist_usernames: rule.users, whitelist_teams: [] }
  }
  const protection = (rule: z.infer<typeof tagProtectionSchema>): GiteaTagProtection => ({
    id: rule.id,
    pattern: rule.name_pattern,
    users: rule.whitelist_usernames ?? [],
    teams: rule.whitelist_teams ?? [],
  })
  const run = (raw: z.infer<typeof runSchema>): GiteaRun => ({
    id: raw.id,
    htmlUrl: raw.html_url,
    path: raw.path ?? null,
    event: raw.event ?? null,
    runAttempt: raw.run_attempt ?? null,
    headSha: raw.head_sha,
    headBranch: raw.head_branch ?? null,
    status: raw.status,
    conclusion: raw.conclusion || null,
  })

  return {
    root,
    async getRepository(owner, name) {
      if (!isGiteaName(owner) || !isGiteaName(name))
        throw badRequest('Invalid repository reference')
      const response = await send(`/repos/${owner}/${name}`, { method: 'GET' })
      const repository = await read('repository lookup', response, 200, repositorySchema, {
        missing: true,
      })
      return (
        repository && {
          id: repository.id,
          owner: repository.owner.login,
          name: repository.name,
          defaultBranch: repository.default_branch,
          private: repository.private,
        }
      )
    },
    async createOrganizationRepository(org, name) {
      if (!isGiteaName(org) || !isGiteaName(name)) throw badRequest('Invalid repository reference')
      const response = await send(`/orgs/${org}/repos`, {
        method: 'POST',
        body: { name, private: true, auto_init: false, default_branch: 'main' },
      })
      const refusal = creationRefusals.get(response.status)
      if (refusal || response.status === 409) {
        await response.body?.cancel().catch(() => undefined)
        if (!refusal) return null
        throw giteaRefused(refusal, `Gitea repository creation returned HTTP ${response.status}`)
      }
      const repository = (await read('repository creation', response, 201, repositorySchema))!
      return {
        id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
        defaultBranch: repository.default_branch,
        private: repository.private,
      }
    },
    async tokenOwner(ownerToken) {
      // GET /token: Gitea 1.27.3 answers it to a token with write:repository alone (2026-10-17);
      // GET /user would want read:user of the owner's token.
      const response = await send('/token', { method: 'GET', token: ownerToken })
      const current = await read('token lookup', response, 200, currentTokenSchema, {
        final: ownerToken !== undefined,
      })
      return current!.user.login
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
    async setRepositorySecret(owner, name, secret, value, ownerToken) {
      const path = secretPath(owner, name, secret)
      const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0
      // Gitea refuses an empty value with 422: a secret is never cleared by writing nothing.
      if (bytes === 0 || bytes > GITEA_SECRET_MAX_BYTES) throw badRequest('Invalid Actions secret')
      const code = await status(
        await send(path, { method: 'PUT', token: ownerToken, body: { data: value } }),
      )
      // 201 when it was created, 204 when it replaced one.
      if (code !== 201 && code !== 204) throw refused('Actions secret update', code)
    },
    async deleteRepositorySecret(owner, name, secret, ownerToken) {
      const code = await status(
        await send(secretPath(owner, name, secret), { method: 'DELETE', token: ownerToken }),
      )
      // 404: no such secret, or no such repository — either way nothing is left to delete.
      if (code !== 204 && code !== 404) throw refused('Actions secret deletion', code)
    },
    async listTagProtections(owner, name, ownerToken) {
      const response = await send(`${repo(owner, name)}/tag_protections`, {
        method: 'GET',
        token: ownerToken,
      })
      if (response.status !== 200) throw refused('tag protection list', await status(response))
      const rules = await read(
        'tag protection list',
        response,
        200,
        z.array(tagProtectionSchema).max(1000),
      )
      return rules!.map(protection)
    },
    async createTagProtection(owner, name, rule, ownerToken) {
      const response = await send(`${repo(owner, name)}/tag_protections`, {
        method: 'POST',
        token: ownerToken,
        body: tagRule(rule),
      })
      if (response.status === 403) {
        await status(response)
        return null
      }
      if (response.status !== 201) throw refused('tag protection', await status(response))
      return protection((await read('tag protection', response, 201, tagProtectionSchema))!)
    },
    async editTagProtection(owner, name, id, rule, ownerToken) {
      if (!tokenId.safeParse(id).success) throw badRequest('Invalid tag protection id')
      const response = await send(`${repo(owner, name)}/tag_protections/${id}`, {
        method: 'PATCH',
        token: ownerToken,
        body: tagRule(rule),
      })
      if (response.status !== 200) throw refused('tag protection update', await status(response))
      return protection((await read('tag protection update', response, 200, tagProtectionSchema))!)
    },
    async createTag(owner, name, tag, target, ownerToken) {
      const path = `${repo(owner, name)}/tags`
      if (!isTagName(tag)) throw badRequest('Invalid tag name')
      if (!sha.safeParse(target).success) throw badRequest('Invalid tag target')
      // No message: a message would make an annotated tag.
      const response = await send(path, {
        method: 'POST',
        token: ownerToken,
        body: { tag_name: tag, target },
      })
      if (response.status === 409) {
        await status(response)
        return null
      }
      // 422: the protection of the tag names another account (recorded 2026-10-17).
      if (response.status === 422)
        throw giteaRefused(
          'forbidden',
          `Gitea tag creation returned HTTP ${await status(response)}`,
        )
      const created = (await read('tag creation', response, 201, tagSchema, { final: true }))!
      if (created.name !== tag || created.commit.sha !== target || created.id !== target)
        throw giteaFailed('Gitea made another tag')
      return { name: created.name, id: created.id, commitSha: created.commit.sha }
    },
    async getTag(owner, name, tag) {
      if (!isTagName(tag)) throw badRequest('Invalid tag name')
      const response = await send(`${repo(owner, name)}/tags/${tag}`, { method: 'GET' })
      const found = await read('tag lookup', response, 200, tagSchema, {
        missing: true,
        final: true,
      })
      if (found && found.name !== tag) throw giteaFailed('Gitea answered with another tag')
      return found && { name: found.name, id: found.id, commitSha: found.commit.sha }
    },
    async listRuns(owner, name, filter, page) {
      if (!Number.isSafeInteger(page) || page < 1) throw badRequest('Invalid run page')
      const query = new URLSearchParams()
      if (filter.headSha !== undefined) {
        if (!sha.safeParse(filter.headSha).success) throw badRequest('Invalid run filter')
        query.set('head_sha', filter.headSha)
      }
      if (filter.event !== undefined) {
        if (!EVENT.test(filter.event)) throw badRequest('Invalid run filter')
        query.set('event', filter.event)
      }
      if (filter.branch !== undefined) {
        if (!DISPATCH_REF.test(filter.branch) || filter.branch.startsWith('refs/'))
          throw badRequest('Invalid run filter')
        query.set('branch', filter.branch)
      }
      query.set('page', String(page))
      query.set('limit', String(GITEA_PAGE_SIZE))
      const response = await send(`${repo(owner, name)}/actions/runs?${query}`, { method: 'GET' })
      const answer = (await read('run list', response, 200, runPageSchema, { final: true }))!
      return { total: answer.total_count, runs: answer.workflow_runs.map(run) }
    },
    async getRun(owner, name, id) {
      if (!tokenId.safeParse(id).success) throw badRequest('Invalid run id')
      const response = await send(`${repo(owner, name)}/actions/runs/${id}`, { method: 'GET' })
      const found = await read('run lookup', response, 200, runSchema, {
        missing: true,
        final: true,
      })
      if (found && found.id !== id) throw giteaFailed('Gitea answered with another run')
      return found && run(found)
    },
    async dispatchWorkflow(owner, name, workflow, request, sourceRepositoryId) {
      const path = repo(owner, name)
      if (!WORKFLOW_FILE.test(workflow)) throw badRequest('Invalid workflow file')
      if (
        !DISPATCH_REF.test(request.ref) ||
        (request.ref.startsWith('refs/') && !/^refs\/(?:heads|tags)\//.test(request.ref)) ||
        request.ref.includes('..') ||
        request.ref.includes('//') ||
        request.ref.endsWith('/')
      )
        throw badRequest('Invalid workflow ref')
      const inputs = Object.entries(request.inputs)
      if (
        inputs.length > MAX_INPUTS ||
        !inputs.every(
          ([key, value]) =>
            INPUT_NAME.test(key) &&
            typeof value === 'string' &&
            Buffer.byteLength(value, 'utf8') <= MAX_INPUT_BYTES,
        )
      )
        throw badRequest('Invalid workflow inputs')
      if (sourceRepositoryId !== undefined && !tokenId.safeParse(sourceRepositoryId).success)
        throw badRequest('Invalid source of scoped workflows')
      const query = new URLSearchParams({ return_run_details: 'true' })
      if (sourceRepositoryId !== undefined)
        query.set('scoped_workflow_source_repo_id', String(sourceRepositoryId))
      const response = await send(`${path}/actions/workflows/${workflow}/dispatches?${query}`, {
        method: 'POST',
        body: { ref: request.ref, inputs: Object.fromEntries(inputs) },
      })
      if (response.status === 422 || response.status === 404) {
        const code = await status(response)
        throw giteaNotSupported(
          code === 422 ? 'no_trigger' : 'not_found',
          `Gitea refused to dispatch the workflow (HTTP ${code})`,
        )
      }
      if (response.status !== 200) throw refused('workflow dispatch', await status(response))
      return (await read('workflow dispatch', response, 200, dispatchedSchema))!.workflow_run_id
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
