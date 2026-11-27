import { z } from 'zod'

import { DomainError } from '../errors.ts'
import { EMBEDDED_TOKEN_PATTERNS, TURN_KEY_PATTERNS } from '../pages/content-check.ts'
import { ciRefusals, ciStatuses, type CiRefusal, type CiStatus } from '../ports/git-provider.ts'
import { ENV_VALUE_MASK, maskEnvValues } from '../workspace-env/env-masking.ts'

// The builds of a project repository and the logs of their jobs (docs/plan/84-projects.md, ПР17,
// §4.1, §4.3, §4.4; slice 84.21). Core polls the provider and keeps what it read in
// `project_ci_runs`; a log is fetched on demand, its tail kept 24 hours in `project_ci_logs` with
// ANSI taken out and the values of the workspace's variables and keys masked. Web and `mcp` read
// those rows only: neither holds a token of git.

/** Runs a repository keeps: the newest ones (CHECK of nothing — core deletes the rest). */
export const REPO_CI_RUNS_KEPT = 50
/** Jobs a run keeps in `project_ci_runs.jobs`. */
export const REPO_CI_JOBS_KEPT = 100
/** The tail of a log core keeps (CHECK `octet_length(text) <= 65536`). */
export const REPO_CI_LOG_BYTES = 64 * 1024
/** How long a kept log lives (ПР17). */
export const REPO_CI_LOG_TTL_MS = 24 * 60 * 60 * 1000
/** Logs the agent reads in one turn (`repo_job_log`, §4.4). */
export const REPO_LOGS_PER_TURN = 5
/** The tick of `git.poll`: active runs are read again at most this often (§4.3, ПР17). */
export const REPO_POLL_EVERY_MS = 30_000
/** Open merge requests are read again at most this often. */
export const REPO_POLL_REQUESTS_MS = 5 * 60_000
/** A repository whose page is open is read at most once a minute (`projectRepo.runs`). */
export const REPO_POLL_ON_LOOK_MS = 60_000
/** A log that is still `loading` after this is asked for again. */
export const REPO_LOG_RETRY_MS = 60_000
/** A log of a job that still runs is fetched again when older than this. */
export const REPO_LOG_REFRESH_MS = 30_000

export const repoCiRunIdSchema = z.string().regex(/^[1-9][0-9]{0,39}$/)

/** One job as `project_ci_runs.jobs` keeps it (v1). */
export const repoCiJobSchema = z.strictObject({
  id: repoCiRunIdSchema,
  name: z.string().max(255),
  stage: z.string().max(255).nullable(),
  status: z.enum(ciStatuses),
  manual: z.boolean(),
  refusal: z.enum(ciRefusals).nullable(),
  url: z.string().max(500),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
})
export type RepoCiJob = z.infer<typeof repoCiJobSchema>

export const repoCiJobsSchema = z.array(repoCiJobSchema).max(REPO_CI_JOBS_KEPT)

/** The jobs of a row, or none when the row holds another form. */
export function readRepoCiJobs(value: unknown): RepoCiJob[] {
  const parsed = repoCiJobsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

const byId = (a: { id: string }, b: { id: string }) => {
  const left = BigInt(a.id)
  const right = BigInt(b.id)
  return left < right ? -1 : left > right ? 1 : 0
}

/** The stages of a run in the order the client's configuration has them, each with its jobs. */
export function ciStagesOf(
  jobs: readonly RepoCiJob[],
): { name: string | null; status: CiStatus; jobs: RepoCiJob[] }[] {
  const stages = new Map<string | null, RepoCiJob[]>()
  // GitLab lists the newest job first: the first stage is the one of the oldest job.
  for (const job of [...jobs].sort(byId)) {
    const list = stages.get(job.stage) ?? []
    list.push(job)
    stages.set(job.stage, list)
  }
  return [...stages].map(([name, list]) => ({ name, status: stageStatusOf(list), jobs: list }))
}

const stageOrder: readonly CiStatus[] = [
  'failed',
  'running',
  'pending',
  'manual',
  'canceled',
  'success',
  'skipped',
]

/** A stage is what its most pressing job is: one failed — failed, one running — running. */
function stageStatusOf(jobs: readonly RepoCiJob[]): CiStatus {
  for (const status of stageOrder) if (jobs.some((job) => job.status === status)) return status
  return 'skipped'
}

/** What the client reads of a run or a job: its status, or its refusal in its own words. */
export function ciStateWord(
  status: CiStatus,
  refusal: CiRefusal | null | undefined,
  words: Readonly<Record<CiStatus, string>>,
): string {
  return refusal ? ciRefusalShortWords[refusal] : words[status]
}

/** A refusal in a status column. */
export const ciRefusalShortWords = Object.freeze({
  account_unverified: 'Не запущена: GitLab просит подтвердить учётную запись',
} satisfies Record<CiRefusal, string>)

/** A refusal explained (ПР17, the review of 15.11.2026). */
export const ciRefusalTexts = Object.freeze({
  account_unverified:
    'GitLab просит подтвердить учётную запись, чтобы запускать сборки на своих серверах: подтвердите её в GitLab или подключите свой раннер',
} satisfies Record<CiRefusal, string>)

/** `project_ci_logs.state`. */
export const repoCiLogStates = ['loading', 'ready', 'failed'] as const
export type RepoCiLogState = (typeof repoCiLogStates)[number]

// --- the log of a job -----------------------------------------------------------------------

/* eslint-disable no-control-regex -- the escapes of a terminal are what is taken out */
// CSI (colours, cursor), OSC (titles, links) and the other two-byte escapes of a terminal.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// GitLab's collapsible sections: `section_start:<time>:<name>[<options>]\r\x1b[0K` and the end.
const SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]\r\n]*\])?\r?/g
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/* eslint-enable no-control-regex */

const globalOf = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
const KEY_PATTERNS = [...TURN_KEY_PATTERNS, ...EMBEDDED_TOKEN_PATTERNS].map(globalOf)

/**
 * The text of a log as the build wrote it, made fit to keep and show (ПР17, §4.6): escapes of the
 * terminal and GitLab's section marks taken out, a line rewritten by `\r` kept as its last state,
 * the values of the workspace's variables and anything of the form of a key — the platform's keys
 * of a turn, tokens of GitHub and GitLab, JWT, private keys — replaced by ENV_VALUE_MASK. Then
 * the tail of at most REPO_CI_LOG_BYTES, cut at a line where it can be.
 */
export function maskCiLog(
  raw: string,
  values: readonly string[],
): { text: string; truncated: boolean } {
  let text = raw.replace(ANSI, '').replace(SECTION, '')
  text = text
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r+$/, '').split('\r')
      return parts.at(-1) ?? ''
    })
    .join('\n')
    .replace(CONTROL, '')
  text = maskEnvValues(text, values)
  for (const pattern of KEY_PATTERNS) text = text.replace(pattern, ENV_VALUE_MASK)
  return tailOf(text, REPO_CI_LOG_BYTES)
}

/** The last `maxBytes` of UTF-8 of a text, from the start of a line when one is near. */
export function tailOf(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return { text, truncated: false }
  let start = bytes.byteLength - maxBytes
  // Not inside a character: skip continuation bytes.
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  let tail = new TextDecoder('utf-8').decode(bytes.subarray(start))
  const newline = tail.indexOf('\n')
  if (newline >= 0 && newline < 4096) tail = tail.slice(newline + 1)
  return { text: tail, truncated: true }
}

// --- the queue `git` ------------------------------------------------------------------------

/** `git.poll`: the tick (no repository) or one repository whose page is open. */
export const gitPollPayloadSchema = z.strictObject({
  projectRepositoryId: z.uuid().optional(),
})
/** `git.log`: the tail of one job's log. */
export const gitLogPayloadSchema = z.strictObject({
  projectRepositoryId: z.uuid(),
  jobId: repoCiRunIdSchema,
})
/** `git.repo.deploy_actions`: the manual jobs of the head of the default branch. */
export const gitDeployActionsPayloadSchema = z.strictObject({ projectRepositoryId: z.uuid() })

// --- the agent's tools (§4.4) ---------------------------------------------------------------

export const repoRunsArgumentsSchema = z.strictObject({
  branch: z.enum(['chat', 'default']).optional(),
  limit: z.number().int().min(1).max(10).optional(),
})
export const repoJobLogArgumentsSchema = z.strictObject({
  runId: z.string().min(1).max(40),
  jobId: z.string().min(1).max(40),
  tailBytes: z.number().int().min(1024).max(32768).optional(),
})

// --- refusals -------------------------------------------------------------------------------

/** The log is being fetched by core: the caller asks again in a few seconds. */
export const repoLogLoading = (): DomainError =>
  new DomainError('REPO_LOG_LOADING', 'The log is being fetched; call again in a few seconds.', 409)

export const repoLogLimit = (): DomainError =>
  new DomainError(
    'REPO_LOG_LIMIT',
    `The logs of this turn (${REPO_LOGS_PER_TURN}) are used up: read what you have, or ask in the next turn.`,
    429,
  )

/** A run or a job the platform does not know in this repository. */
export const repoRunNotFound = (): DomainError =>
  new DomainError('REPO_RUN_NOT_FOUND', 'No such build in this repository', 404)

export const repoLogFailed = (): DomainError =>
  new DomainError('REPO_LOG_FAILED', 'The log could not be fetched', 502)

/** A press whose core went away while it ran: nobody knows whether it reached the provider. */
export const repoActionLost = (): DomainError =>
  new DomainError('REPO_ACTION_LOST', 'The press was interrupted', 500)

export const repoCiRunTexts = Object.freeze({
  REPO_LOG_LOADING: 'Получаем журнал…',
  REPO_LOG_LIMIT: 'Агент уже прочитал пять журналов в этом ходе',
  REPO_RUN_NOT_FOUND: 'Такой сборки нет',
  REPO_LOG_FAILED: 'Не удалось получить журнал — попробуйте ещё раз',
  REPO_ACTION_LOST:
    'Не знаем, дошло ли нажатие до репозитория: проверьте ветку в репозитории и нажмите ещё раз',
} satisfies Record<string, string>)
