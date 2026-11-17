import { enqueueOutbox, type PrismaClient } from '@repo/db'
import {
  githubHost,
  gitJobNames,
  type GitConnectionReason,
  gitRefreshAvailableAt,
  gitRefreshDedupeKey,
  gitRefreshPayloadSchema,
  type GitRefreshPayload,
  type GitWebhookProvider,
} from '@repo/domain'
import {
  gitlabHookKeyId,
  gitlabHookSecrets,
  parseGithubInstallationWebhook,
  parseGithubWebhook,
  parseGitlabWebhook,
  verifyGithubSignature,
  verifyGitlabDelivery,
  type GithubInstallationHint,
  type GitWebhookHint,
} from '@repo/git-providers/webhooks'

import { MAX_WEBHOOK_BODY_BYTES, readBodyWithin } from './body-limit'

// The webhooks of the repositories of projects (docs/plan/84-projects.md, ПР17, §4.3, §4.6; slice
// 84.26): `POST /api/webhooks/github` — the one webhook of the GitHub App, for every installation —
// and `POST /api/webhooks/gitlab?r=<projectRepositoryId>` — the hook core made on a GitLab project.
// A delivery is only a hint: its signature is checked, its id kept against a repeat, and a
// `git.refresh` written for core in the same transaction — core reads the state again from the
// provider. The body is never kept; web calls no provider. Answers are bare: a sender learns only
// whether it was taken.
//
// An `installation` event of the GitHub App is not a hint (§10, «Открытое — закрыто (17.11.2026)»):
// deleted or suspended, the connections of that installation stop at once — `reauth_needed` by
// `installation_gone`, so cards and runs refuse as for a sign-in to renew and the repository row
// offers «Подключить заново»; unsuspended or created again, they go back to `checking` and core
// checks them (`git.connection.sync`).

export interface GitWebhookDeps {
  prisma: Pick<PrismaClient, '$transaction' | 'projectRepository'>
  now: () => Date
}

const bare = (status: number) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store' } })

async function bodyOf(request: Request): Promise<string | Response> {
  let body: Buffer | null
  try {
    body = await readBodyWithin(request, MAX_WEBHOOK_BODY_BYTES)
  } catch {
    return bare(400)
  }
  if (body === null) return bare(413)
  return body.toString('utf8')
}

/**
 * The delivery is kept and the hints of the repositories written, in one transaction; a delivery
 * id taken before writes nothing. The rows of one window coalesce by their dedupe key.
 */
async function takeDelivery(
  deps: GitWebhookDeps,
  provider: GitWebhookProvider,
  hint: GitWebhookHint,
  repositoryIds: readonly string[],
): Promise<boolean> {
  const now = deps.now()
  return deps.prisma.$transaction(async (tx) => {
    const kept = await tx.gitWebhookDelivery.createMany({
      data: [{ provider, deliveryId: hint.deliveryId, receivedAt: now }],
      skipDuplicates: true,
    })
    if (kept.count === 0) return false
    for (const projectRepositoryId of repositoryIds) {
      const payload: GitRefreshPayload = gitRefreshPayloadSchema.parse({
        projectRepositoryId,
        kind: hint.kind,
        ...(hint.number === undefined ? {} : { number: hint.number }),
        ...(hint.runId === undefined ? {} : { runId: hint.runId }),
      })
      await enqueueOutbox(tx, {
        topic: 'git',
        type: gitJobNames.refresh,
        payload,
        dedupeKey: gitRefreshDedupeKey(payload, now),
        availableAt: gitRefreshAvailableAt(now),
      })
    }
    return true
  })
}

const INSTALLATION_GONE: GitConnectionReason = 'installation_gone'

/**
 * The connections of one installation of the GitHub App, stopped or given back to a check, in the
 * transaction that keeps the delivery. A connection the member's leaving suspended stays so.
 */
async function takeInstallation(deps: GitWebhookDeps, hint: GithubInstallationHint): Promise<void> {
  const now = deps.now()
  const installationId = BigInt(hint.installationId)
  await deps.prisma.$transaction(async (tx) => {
    const kept = await tx.gitWebhookDelivery.createMany({
      data: [{ provider: 'github', deliveryId: hint.deliveryId, receivedAt: now }],
      skipDuplicates: true,
    })
    if (kept.count === 0) return
    const of = { kind: 'github_app', host: githubHost, installationId }
    if (hint.change === 'gone') {
      await tx.gitConnection.updateMany({
        where: { ...of, state: { not: 'suspended' } },
        data: { state: 'reauth_needed', stateReason: INSTALLATION_GONE, checkedAt: now },
      })
      return
    }
    const back = await tx.gitConnection.findMany({
      where: { ...of, state: 'reauth_needed', stateReason: INSTALLATION_GONE },
      select: { id: true },
      take: 50,
    })
    for (const { id } of back) {
      await tx.gitConnection.updateMany({
        where: { id, state: 'reauth_needed', stateReason: INSTALLATION_GONE },
        data: { state: 'checking', stateReason: null, checkedAt: now },
      })
      await enqueueOutbox(tx, {
        topic: 'git',
        type: gitJobNames.connectionSync,
        payload: { connectionId: id },
        dedupeKey: `git.connection.sync:${id}:${Math.floor(now.getTime() / 10_000)}`,
      })
    }
  })
}

/**
 * `POST /api/webhooks/github`. `webhookSecret` null — no GitHub App here: 404. The repositories of
 * an event are found by their id on github.com: every project whose repository it is gets a hint.
 */
export async function handleGithubWebhook(
  request: Request,
  deps: GitWebhookDeps & { webhookSecret: string | null },
): Promise<Response> {
  if (!deps.webhookSecret) return bare(404)
  const raw = await bodyOf(request)
  if (typeof raw !== 'string') return raw
  if (!verifyGithubSignature(request.headers, raw, deps.webhookSecret)) return bare(401)
  const installation = parseGithubInstallationWebhook(request.headers, raw)
  if (installation !== null) {
    await takeInstallation(deps, installation)
    return bare(202)
  }
  const hint = parseGithubWebhook(request.headers, raw)
  // An event of no repository (ping) or not one core reads: taken, nothing to do.
  if (hint === null) return bare(202)
  const rows = await deps.prisma.projectRepository.findMany({
    where: { provider: 'github', host: githubHost, providerRepoId: hint.providerRepoId },
    select: { id: true },
    take: 50,
  })
  if (rows.length === 0) return bare(202)
  await takeDelivery(
    deps,
    'github',
    hint,
    rows.map((row) => row.id),
  )
  return bare(202)
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `POST /api/webhooks/gitlab?r=<projectRepositoryId>`. The hook of that repository: its token and
 * signing token are derived from REPO_CONFIRM_SECRET and its nonce; a hook GitLab said it signs must
 * come signed. A repository without a hook, or whose hook was made by another root secret, answers
 * 404 — GitLab then turns the hook off by itself.
 */
export async function handleGitlabWebhook(
  request: Request,
  deps: GitWebhookDeps & { rootSecret: string | null },
): Promise<Response> {
  if (!deps.rootSecret) return bare(404)
  const id = new URL(request.url).searchParams.get('r') ?? ''
  if (!uuid.test(id)) return bare(404)
  const raw = await bodyOf(request)
  if (typeof raw !== 'string') return raw
  const row = await deps.prisma.projectRepository.findUnique({
    where: { id: id.toLowerCase() },
    select: {
      id: true,
      provider: true,
      providerRepoId: true,
      hookState: true,
      hookNonce: true,
      hookKeyId: true,
      hookSigned: true,
    },
  })
  if (
    row === null ||
    row.provider !== 'gitlab' ||
    row.hookState !== 'active' ||
    row.hookNonce === null ||
    row.hookKeyId !== gitlabHookKeyId(deps.rootSecret)
  )
    return bare(404)
  const secrets = gitlabHookSecrets(deps.rootSecret, row.id, row.hookNonce)
  const check = verifyGitlabDelivery(request.headers, raw, secrets, {
    requireSignature: row.hookSigned,
    now: deps.now(),
  })
  if (!check.ok) return bare(401)
  const hint = parseGitlabWebhook(request.headers, raw)
  // Another project's event under this repository's hook is not this repository's.
  if (hint === null || hint.providerRepoId !== row.providerRepoId) return bare(202)
  await takeDelivery(deps, 'gitlab', hint, [row.id])
  return bare(202)
}
