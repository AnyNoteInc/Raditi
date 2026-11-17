import { z } from 'zod'

import { DomainError } from '../errors.ts'
import { repoConfirmExpired } from './errors.ts'

// The confirmation of a button of a repository (docs/plan/84-projects.md, ПР13, ПР15, ПР16, §4.4):
// `projectRepo.prepare…` hands the client a token — the claims and their HMAC by
// REPO_CONFIRM_SECRET —, `confirm…` checks it and writes a row of `repo_actions` that holds the
// token itself; core checks it again before it calls the provider (ПР15: one user of PostgreSQL
// for every service — a row inserted without a press must not run). The domain fixes the claims,
// the material and the form of the token; the HMAC is the transport's, by a function it passes.

export const REPO_CONFIRM_TTL_SECONDS = 10 * 60

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * `rerun` and `cancel` — a build (Э10, 84.26; ПР17): the run, its ref and its commit; a rerun of a
 * build of the main branch or of one with deploy jobs is a card of a deploy (`run.deploy`, ПР15).
 * `revert` — «Отменить» of a merged request (ПР15): its number, the main branch and the merge commit.
 */
export const repoConfirmKinds = [
  'push',
  'merge',
  'deploy',
  'ci_change',
  'rerun',
  'cancel',
  'revert',
] as const
export type RepoConfirmKind = (typeof repoConfirmKinds)[number]

const runClaim = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  ref: z.string().min(1).max(255),
  /** The card of a deploy: the main branch, deploy jobs or a workflow started by hand (ПР15). */
  deploy: z.boolean(),
})

export const repoConfirmClaimsSchema = z
  .strictObject({
    /** `push` with `opensMergeRequest` — the first push and the merge request (ПР14). */
    kind: z.enum(repoConfirmKinds),
    userId: z.uuid(),
    projectId: z.uuid(),
    projectRepositoryId: z.uuid(),
    taskId: z.uuid().nullable(),
    /** The merge request (merge). */
    number: z.number().int().positive().nullable(),
    /** The branch the push goes to (push) or the target of the merge request (merge). */
    targetBranch: z.string().min(1).max(255).nullable(),
    /** push: the head of the chat in the mirror; deploy: the head of the main branch. */
    headSha: sha,
    /** push: the diff of the card the client was shown. */
    diffSha256: sha256.nullable(),
    ciDiffSha256: sha256.nullable(),
    opensMergeRequest: z.boolean(),
    deploy: z
      .strictObject({
        kind: z.enum(['manual_job', 'workflow_dispatch']),
        id: z.string().min(1).max(200),
        ref: z.string().min(1).max(255),
      })
      .nullable(),
    /** rerun and cancel: the build (84.26); absent or null for every other kind. */
    run: runClaim.nullable().optional(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    /** Unix seconds. */
    expiresAt: z.number().int().positive(),
  })
  // A build is named by exactly the cards of a build: the material has its line only then.
  .refine(
    (claims) => (claims.run != null) === (claims.kind === 'rerun' || claims.kind === 'cancel'),
  )
export type RepoConfirmClaims = z.infer<typeof repoConfirmClaimsSchema>

/** The text the HMAC is computed over: every claim, in this order (§4.4). */
export function repoConfirmMaterial(claims: RepoConfirmClaims): string {
  const value = repoConfirmClaimsSchema.parse(claims)
  return [
    'raditi-repo-confirm:v1',
    value.kind,
    value.userId,
    value.projectId,
    value.projectRepositoryId,
    value.taskId ?? '-',
    value.number ?? '-',
    value.targetBranch ?? '-',
    value.headSha,
    value.diffSha256 ?? '-',
    value.ciDiffSha256 ?? '-',
    value.opensMergeRequest ? '1' : '0',
    value.deploy ? `${value.deploy.kind}:${value.deploy.ref}:${value.deploy.id}` : '-',
    // Only the cards of a build carry this line: the material of every other kind is as before.
    ...(value.run
      ? [`run:${value.run.id}:${value.run.deploy ? 'deploy' : 'plain'}:${value.run.ref}`]
      : []),
    value.nonce,
    value.expiresAt,
  ].join('\n')
}

/** HMAC-SHA256 of the material by REPO_CONFIRM_SECRET, in base64url: the transport's. */
export type RepoConfirmMac = (material: string) => string

const toBase64Url = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    )
  } catch {
    return null
  }
}

/** Constant time for strings of one length; a length differs — false at once. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The token a card hands out: `<claims in base64url>.<mac>`. */
export function signRepoConfirmToken(claims: RepoConfirmClaims, mac: RepoConfirmMac): string {
  const value = repoConfirmClaimsSchema.parse(claims)
  return `${toBase64Url(JSON.stringify(value))}.${mac(repoConfirmMaterial(value))}`
}

/** A token that is not one the platform signed: never told apart from a stale one to the client. */
export const repoConfirmInvalid = (): DomainError =>
  new DomainError('REPO_CONFIRM_INVALID', 'The confirmation is not valid', 409)

/** At most this long: claims of a few hundred bytes and a MAC. */
export const REPO_CONFIRM_TOKEN_MAX = 2048

/**
 * The claims of a token the platform signed and that has not expired: REPO_CONFIRM_INVALID for
 * anything else, REPO_CONFIRM_EXPIRED once its ten minutes passed. Both web and core call it.
 */
export function readRepoConfirmToken(
  token: string,
  mac: RepoConfirmMac,
  now: Date,
): RepoConfirmClaims {
  if (typeof token !== 'string' || token.length > REPO_CONFIRM_TOKEN_MAX) throw repoConfirmInvalid()
  const [body, given, ...rest] = token.split('.')
  if (!body || !given || rest.length) throw repoConfirmInvalid()
  const json = fromBase64Url(body)
  if (json === null) throw repoConfirmInvalid()
  let parsed: ReturnType<typeof repoConfirmClaimsSchema.safeParse>
  try {
    parsed = repoConfirmClaimsSchema.safeParse(JSON.parse(json))
  } catch {
    throw repoConfirmInvalid()
  }
  if (!parsed.success) throw repoConfirmInvalid()
  if (!sameText(mac(repoConfirmMaterial(parsed.data)), given)) throw repoConfirmInvalid()
  if (now.getTime() >= parsed.data.expiresAt * 1000) throw repoConfirmExpired()
  return parsed.data
}
