import { z } from 'zod'

// The feed rows of a project repository (docs/plan/84-projects.md, §4.4): the card «Изменения в
// ветке», the agent's proposal of a merge request, what a button did, why changes were left, and
// the CI variables the client adds. The rows carry no token, no value of a variable and no diff:
// the diff lives in raditi-artifacts.

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const branch = z.string().min(1).max(255)
const count = z.number().int().nonnegative()
const httpsUrl = z.url({ protocol: /^https$/ }).max(500)

const changedFile = z.strictObject({
  path: z.string().min(1).max(4096),
  additions: count,
  deletions: count,
})

/** `feed.repo_changes` v1. */
export const feedRepoChangesPayloadSchema = z.strictObject({
  v: z.literal(1),
  branch,
  baseSha: sha,
  headSha: sha,
  diffSha256: sha256,
  files: count,
  additions: count,
  deletions: count,
  list: z.array(changedFile).max(50),
  ciTouched: z.boolean(),
  pushed: z.boolean(),
  mergeRequest: z.strictObject({ number: z.number().int().positive(), url: httpsUrl }).nullable(),
})
export type FeedRepoChangesPayload = z.infer<typeof feedRepoChangesPayloadSchema>

/** `feed.repo_proposal` v1 — the agent proposes a merge request (ПР14). */
export const feedRepoProposalPayloadSchema = z.strictObject({
  v: z.literal(1),
  reservedId: z.uuid(),
  title: z.string().min(1).max(120),
  description: z.string().max(4000),
  draft: z.boolean(),
})
export type FeedRepoProposalPayload = z.infer<typeof feedRepoProposalPayloadSchema>

/** What a confirmed button does (§4.1, `repo_actions.kind`). */
export const repoActionKinds = ['push', 'open_mr', 'merge', 'deploy', 'ci_push'] as const
export type RepoActionKind = (typeof repoActionKinds)[number]

/** `waiting` — the provider merges once the pipeline passes (`auto_merge`, ПР15). */
export const repoActionStates = ['queued', 'waiting', 'running', 'done', 'failed'] as const
export type RepoActionState = (typeof repoActionStates)[number]

/** `feed.repo_action` v1. */
export const feedRepoActionPayloadSchema = z.strictObject({
  v: z.literal(1),
  actionId: z.uuid(),
  kind: z.enum(repoActionKinds),
  state: z.enum(repoActionStates),
  number: z.number().int().positive().optional(),
  url: httpsUrl.optional(),
  error: z.string().min(1).max(64).optional(),
})
export type FeedRepoActionPayload = z.infer<typeof feedRepoActionPayloadSchema>

export const repoLeftReasons = [
  'secret_found',
  'client_value',
  'too_large',
  'conflict',
  'unreachable',
  'reauth',
  'failed',
] as const
export type RepoLeftReason = (typeof repoLeftReasons)[number]

/** `feed.repo_left` v1 — changes not saved or not sent; paths without values. */
export const feedRepoLeftPayloadSchema = z.strictObject({
  v: z.literal(1),
  reason: z.enum(repoLeftReasons),
  paths: z.array(z.string().min(1).max(4096)).max(50).optional(),
})
export type FeedRepoLeftPayload = z.infer<typeof feedRepoLeftPayloadSchema>

/** `feed.repo_ci_vars` v1 — variables the client adds in the provider's settings (ПР34). */
export const feedRepoCiVarsPayloadSchema = z.strictObject({
  v: z.literal(1),
  names: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/))
    .min(1)
    .max(20),
  settingsUrl: httpsUrl,
})
export type FeedRepoCiVarsPayload = z.infer<typeof feedRepoCiVarsPayloadSchema>

/**
 * The line of a `feed.repo_action` (§4.4). `label` is `mergeRequestLabel` of the adapter; `brand`
 * is its `support.label`.
 */
export function repoActionText(
  row: Pick<FeedRepoActionPayload, 'kind' | 'state'>,
  label: string | null,
): string {
  if (row.state === 'failed') return 'Не получилось — попробуйте ещё раз'
  if (row.state === 'queued' || row.state === 'running') return 'Выполняем…'
  if (row.state === 'waiting') return 'Примем в основную ветку, когда сборка пройдёт'
  switch (row.kind) {
    case 'push':
    case 'ci_push':
      return 'Изменения отправлены в ветку'
    case 'open_mr':
      return label === null ? 'Запрос на слияние открыт' : `Запрос на слияние ${label} открыт`
    case 'merge':
      return 'Принято в основную ветку'
    case 'deploy':
      return 'Выкладка запущена'
  }
}

/** The line of a `feed.repo_left`. */
export const repoLeftTexts = Object.freeze({
  secret_found: 'Изменения не сохранены: в них нашёлся пароль или ключ',
  client_value: 'Изменения не сохранены: в них значение переменной',
  too_large: 'Изменения не сохранены: они слишком большие',
  conflict:
    'Изменения не отправлены: ветку изменили в репозитории, и они не легли поверх. Попросите агента повторить',
  unreachable: 'Не удалось получить репозиторий — попробуем в следующем сообщении',
  reauth: 'Нужно войти в GitLab заново',
  failed: 'Изменения не сохранены — попробуйте ещё раз',
} satisfies Record<RepoLeftReason, string>)

/** «Добавьте в <марка> переменные: …» (ПР34). */
export function repoCiVarsText(brand: string, names: readonly string[]): string {
  return `Добавьте в ${brand} переменные: ${names.join(', ')}`
}
