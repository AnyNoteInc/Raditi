import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { GIT_WEBHOOK_SIGNATURE_WINDOW_S, type GitRefreshKind } from '@repo/domain'

// The webhooks of the repositories of projects (docs/plan/84-projects.md, ПР17, §4.3, §4.6; slice
// 84.26): `@repo/git-providers/webhooks`, the subpath web may import. The signature checks come
// from the webhooks of plan 53 (`webhook-signature.ts` of `main` before plan 83) with the signing
// tokens of GitLab ≥ 19.0 (Standard Webhooks); the parsing reads only what names the repository
// and the object a delivery is about. Nothing a delivery says is trusted beyond that: core reads
// the state again from the provider.

const HEX_SHA256 = /^[0-9a-f]{64}$/i

/** Constant-time check of a hex HMAC-SHA256 of the raw body; malformed input is simply rejected. */
function hmacMatches(secret: string, rawBody: string, signatureHex: string | null): boolean {
  // An empty secret would let anyone forge a signature: fail closed.
  if (!secret || !signatureHex || !HEX_SHA256.test(signatureHex)) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'))
}

/** Both sides hashed first: the comparison is constant-time and does not tell the length. */
function sameSecret(given: string | null, expected: string): boolean {
  if (!expected || !given) return false
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(given), digest(expected))
}

/** GitHub: `X-Hub-Signature-256` is `sha256=` + hex HMAC-SHA256 of the raw body. */
export function verifyGithubSignature(headers: Headers, rawBody: string, secret: string): boolean {
  const header = headers.get('x-hub-signature-256')
  const prefix = 'sha256='
  if (!header?.startsWith(prefix)) return false
  return hmacMatches(secret, rawBody, header.slice(prefix.length))
}

/**
 * The secrets of the hook of one repository (ПР17): derived from REPO_CONFIRM_SECRET by HMAC with a
 * label of their own, so web checks a delivery without a secret in the database, and a new nonce
 * of the repository's hook is a new pair. `keyId` names the root secret: after its rotation the
 * hooks of the old one are made again by core.
 */
export interface GitlabHookSecrets {
  /** What GitLab sends back in `X-Gitlab-Token`. */
  token: string
  /** `whsec_<base64 of 32 bytes>`: the signing token of GitLab ≥ 19.0. */
  signingToken: string
  /** 16 hex characters of the root secret's own HMAC. */
  keyId: string
}

const LABEL = 'raditi-gitlab-hook:v1'

export function gitlabHookSecrets(
  rootSecret: string,
  projectRepositoryId: string,
  nonce: string,
): GitlabHookSecrets {
  if (!rootSecret) throw new Error('A hook needs a root secret')
  const derive = (part: string) =>
    createHmac('sha256', rootSecret)
      .update(`${LABEL}\n${projectRepositoryId.toLowerCase()}\n${nonce}\n${part}`)
      .digest()
  return {
    token: derive('token').toString('base64url'),
    signingToken: `whsec_${derive('signing').toString('base64')}`,
    keyId: gitlabHookKeyId(rootSecret),
  }
}

/** The id of the root secret the hooks are derived from. */
export function gitlabHookKeyId(rootSecret: string): string {
  return createHmac('sha256', rootSecret).update(`${LABEL}\nkey-id`).digest('hex').slice(0, 16)
}

export type GitlabDeliveryCheck =
  { ok: true; signed: boolean } | { ok: false; reason: 'token' | 'signature' | 'unsigned' | 'time' }

/**
 * A delivery of a GitLab project hook. With `webhook-signature` (Standard Webhooks: `v1,<base64>`
 * of HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>` by the decoded signing token) the
 * signature must match and the time be within GIT_WEBHOOK_SIGNATURE_WINDOW_S; a hook GitLab said it
 * signs (`requireSignature`) is refused without one. Otherwise `X-Gitlab-Token` must be the token.
 */
export function verifyGitlabDelivery(
  headers: Headers,
  rawBody: string,
  secrets: Pick<GitlabHookSecrets, 'token' | 'signingToken'>,
  opts: { requireSignature: boolean; now: Date },
): GitlabDeliveryCheck {
  const signature = headers.get('webhook-signature')
  if (signature !== null) {
    const id = headers.get('webhook-id') ?? ''
    const timestamp = headers.get('webhook-timestamp') ?? ''
    if (!/^[0-9]{1,12}$/.test(timestamp) || id === '' || id.length > 200)
      return { ok: false, reason: 'signature' }
    const at = Number(timestamp)
    if (Math.abs(opts.now.getTime() / 1000 - at) > GIT_WEBHOOK_SIGNATURE_WINDOW_S)
      return { ok: false, reason: 'time' }
    const key = Buffer.from(secrets.signingToken.replace(/^whsec_/, ''), 'base64')
    const expected = Buffer.from(
      `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64')}`,
    )
    const matches = signature
      .split(' ')
      .slice(0, 8)
      .some((given) => {
        const value = Buffer.from(given)
        return value.length === expected.length && timingSafeEqual(value, expected)
      })
    return matches ? { ok: true, signed: true } : { ok: false, reason: 'signature' }
  }
  if (opts.requireSignature) return { ok: false, reason: 'unsigned' }
  return sameSecret(headers.get('x-gitlab-token'), secrets.token)
    ? { ok: true, signed: false }
    : { ok: false, reason: 'token' }
}

/** What a delivery is about, as far as web reads it: the repository and the object. */
export interface GitWebhookHint {
  /** The id of the delivery, kept against a repeat. */
  deliveryId: string
  /** The provider's id of the repository (GitHub `repository.id`, GitLab `project.id`). */
  providerRepoId: string
  kind: GitRefreshKind
  number?: number
  runId?: string
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const idOf = (value: unknown): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null

const numberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : null

function jsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    return objectOf(JSON.parse(rawBody))
  } catch {
    return null
  }
}

const deliveryIdOf = (value: string | null): string | null =>
  value !== null && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : null

/**
 * A delivery of the GitHub App (https://docs.github.com/en/webhooks/webhook-events-and-payloads):
 * `push`, `pull_request`, `workflow_run`, `workflow_job`, `check_suite`, `check_run`, `status`.
 * null — an event of no repository (installation, ping) or not one core reads.
 */
export function parseGithubWebhook(headers: Headers, rawBody: string): GitWebhookHint | null {
  const deliveryId = deliveryIdOf(headers.get('x-github-delivery'))
  const event = headers.get('x-github-event')
  const body = jsonBody(rawBody)
  if (deliveryId === null || event === null || body === null) return null
  const providerRepoId = idOf(objectOf(body.repository)?.id)
  if (providerRepoId === null) return null
  const base = { deliveryId, providerRepoId }
  switch (event) {
    case 'push':
      return { ...base, kind: 'push' }
    case 'pull_request': {
      const number = numberOf(objectOf(body.pull_request)?.number ?? body.number)
      return number === null
        ? { ...base, kind: 'merge_request' }
        : { ...base, kind: 'merge_request', number }
    }
    case 'workflow_run': {
      const runId = idOf(objectOf(body.workflow_run)?.id)
      return runId === null ? { ...base, kind: 'pipeline' } : { ...base, kind: 'pipeline', runId }
    }
    case 'workflow_job': {
      const runId = idOf(objectOf(body.workflow_job)?.run_id)
      return runId === null ? { ...base, kind: 'pipeline' } : { ...base, kind: 'pipeline', runId }
    }
    case 'check_suite':
    case 'check_run':
    case 'status':
      return { ...base, kind: 'checks' }
    default:
      return null
  }
}

/**
 * A delivery of a GitLab project hook (https://docs.gitlab.com/user/project/integrations/webhook_events/):
 * push, merge request and pipeline events. The id of the delivery is `webhook-id` (GitLab ≥ 19.0),
 * otherwise `X-Gitlab-Event-UUID`; without either, the hash of the body.
 */
export function parseGitlabWebhook(headers: Headers, rawBody: string): GitWebhookHint | null {
  const body = jsonBody(rawBody)
  if (body === null) return null
  const providerRepoId = idOf(objectOf(body.project)?.id ?? body.project_id)
  if (providerRepoId === null) return null
  const deliveryId =
    deliveryIdOf(headers.get('webhook-id')) ??
    deliveryIdOf(headers.get('x-gitlab-event-uuid')) ??
    `sha256:${createHash('sha256').update(rawBody, 'utf8').digest('hex').slice(0, 64)}`
  const attributes = objectOf(body.object_attributes)
  const base = { deliveryId, providerRepoId }
  switch (body.object_kind) {
    case 'push':
      return { ...base, kind: 'push' }
    case 'merge_request': {
      const number = numberOf(attributes?.iid)
      return number === null
        ? { ...base, kind: 'merge_request' }
        : { ...base, kind: 'merge_request', number }
    }
    case 'pipeline': {
      const runId = idOf(attributes?.id)
      return runId === null ? { ...base, kind: 'pipeline' } : { ...base, kind: 'pipeline', runId }
    }
    case 'build': {
      const runId = idOf(body.pipeline_id)
      return runId === null ? { ...base, kind: 'pipeline' } : { ...base, kind: 'pipeline', runId }
    }
    default:
      return null
  }
}
