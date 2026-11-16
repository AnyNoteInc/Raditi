'use client'

import {
  ciRefusalShortWords,
  ciRefusalTexts,
  ciStagesOf,
  ciStatusWords,
  checksStateWords,
  pullRequestStateWords,
  repoBranchStateWords,
  repoProviderBrands,
  repoOffersDeploy,
  repoProviderOffers,
  type CiRefusal,
  type CiStatus,
  type RepoCiJob,
} from '@repo/domain/repo'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Typography from '@mui/material/Typography'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

import type { ProjectDetails } from './project-types'
import { DeployButton } from './repo-deploy'
import { repoText } from './repo-texts'

// The repository of a project and its builds (docs/plan/84-projects.md, ПР17, §4.8; slice 84.21;
// P-repo, P-pipeline): the card of the repository, «Сборки (CI/CD)», «Запросы на слияние» and
// «Ветки агента»; a build with its stages and jobs, and the log of a job across the whole width,
// folded until it is opened. Statuses are Russian, names of stages and jobs — the client's own, the
// log — as the build wrote it. Core polls the provider; the page reads again while a build goes.

/** While a build goes or core polls, the page reads again this often. */
export const RUNS_POLL_MS = 15_000
const LOG_POLL_MS = 2_000

export const runText = Object.freeze({
  title: 'Репозиторий, сборки',
  back: 'К проекту',
  allRuns: 'Все сборки',
  mainBranch: 'основная ветка',
  openAt: (label: string) => `Открыть в ${label}`,
  runs: 'Сборки (CI/CD)',
  requests: (n: number) => `Запросы на слияние · ${n}`,
  branches: (n: number) => `Ветки агента · ${n}`,
  all: 'Все',
  failed: 'Упали',
  going: 'Идут',
  stagesNote: 'Этапы — имена из вашей настройки сборки. Пока сборка идёт, список обновляется сам.',
  columns: ['Состояние', 'Сборка', 'Этапы', 'Длительность', 'Когда'] as const,
  fromChat: (title: string | null) => `из чата «${title ?? 'Без названия'}»`,
  none: 'Сборок пока нет. Они появятся, когда в репозитории запустится сборка.',
  reading: 'Читаем сборки из репозитория…',
  noRepository: 'У проекта нет репозитория.',
  more: 'Показать ещё',
  run: (id: string) => `Сборка #${id}`,
  ranFor: (when: string, duration: string | null) => (duration ? `${when}, шла ${duration}` : when),
  noRequests: 'Запросов на слияние пока нет.',
  noBranches: 'Агент пока не создал ни одной ветки.',
  pushed: 'отправлена',
  local: 'в Радити',
  log: (name: string) => `Журнал задания «${name}»`,
  stage: (name: string) => `этап «${name}»`,
  openLog: 'Показать журнал',
  hideLog: 'Свернуть журнал',
  logLoading: 'Получаем журнал…',
  logFailed: 'Не удалось получить журнал — попробуйте ещё раз.',
  logTail: 'Показаны последние 64 КБ',
  logAsIs: 'Журнал показан как есть, на языке сборки',
  logEmpty: 'Журнал пуст.',
  retry: 'Ещё раз',
  workLoading: 'Загружаем…',
  noJobs: 'Заданий сборки ещё нет.',
  lastRun: 'Последняя сборка',
  allRunsLink: 'Сборки',
})

export const repositoryHref = (projectId: string) => `/projects/${projectId}/repository`
export const runHref = (projectId: string, runId: string) =>
  `/projects/${projectId}/repository/runs/${runId}`

const active = (status: CiStatus) => status === 'pending' || status === 'running'

/** «Идёт», «Упала», «Ждёт ручного запуска»…; a run gitlab.com did not start — in its own words. */
export function ciWord(status: CiStatus, refusal: CiRefusal | null | undefined): string {
  return refusal ? ciRefusalShortWords[refusal] : ciStatusWords[status]
}

const tone = (status: CiStatus, refusal: CiRefusal | null | undefined) =>
  refusal
    ? 'warning.main'
    : status === 'success'
      ? 'success.main'
      : status === 'failed'
        ? 'error.main'
        : status === 'running' || status === 'pending'
          ? 'primary.main'
          : 'text.secondary'

export function CiStatusChip({
  status,
  refusal,
}: {
  status: CiStatus
  refusal?: CiRefusal | null
}) {
  return (
    <Box
      component="span"
      data-ci-status={refusal ? refusal : status}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        fontSize: 13,
        fontWeight: 500,
        color: tone(status, refusal),
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'currentColor', flex: 'none' }}
      />
      {ciWord(status, refusal)}
    </Box>
  )
}

/** «1 мин 40 с», «52 с»; null when either end is unknown. */
export function durationOf(start: Date | string | null, end: Date | string | null): string | null {
  if (start === null) return null
  const from = new Date(start).getTime()
  const to = end === null ? Date.now() : new Date(end).getTime()
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds} с`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} мин ${String(seconds % 60).padStart(2, '0')} с`
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

const time = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
})
const day = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Moscow',
})

/** «сейчас», «8 мин назад», «1 ч назад», «вчера, 18:20», «12 нояб.». */
export function whenOf(at: Date | string, now = new Date()): string {
  const date = new Date(at)
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return 'сейчас'
  if (minutes < 60) return `${minutes} мин назад`
  if (minutes < 6 * 60) return `${Math.floor(minutes / 60)} ч назад`
  const yesterday = new Date(now.getTime() - 24 * 60 * 60_000)
  if (day.format(date) === day.format(now)) return `сегодня, ${time.format(date)}`
  if (day.format(date) === day.format(yesterday)) return `вчера, ${time.format(date)}`
  return day.format(date)
}

function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Box
      component={Link}
      href={href}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 44,
        color: 'text.secondary',
        textDecoration: 'none',
        fontSize: 14,
        borderRadius: '8px',
        '&:hover': { color: 'text.primary' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
      }}
    >
      <AppIcon name="back" size={16} />
      {children}
    </Box>
  )
}

const card = {
  border: 1,
  borderColor: 'divider',
  borderRadius: '14px',
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
} as const

/** The card of the repository: its path, where it lives, its main branch, how it is connected. */
function RepositoryCard({
  project,
}: {
  project: Pick<ProjectDetails, 'id' | 'name' | 'repository'>
}) {
  const trpc = useTRPC()
  const { data: repo } = useQuery({
    ...trpc.projectRepo.get.queryOptions({ projectId: project.id }),
    initialData: project.repository,
  })
  if (!repo) return <Alert severity="info">{runText.noRepository}</Alert>
  const brand = repoProviderBrands[repo.provider]
  const label = brand.label
  return (
    <Box sx={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
      <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
        <AppIcon name={brand.icon} size={20} />
      </Box>
      <Box sx={{ flex: '1 1 240px', minWidth: 0 }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{project.name}</Typography>
        <Typography
          component="h1"
          sx={{ fontSize: 22, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.3 }}
        >
          {repo.path}
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          {repo.host} · {runText.mainBranch}{' '}
          <Box component="span" sx={{ fontFamily: 'var(--font-mono, monospace)' }}>
            {repo.defaultBranch}
          </Box>{' '}
          · {repo.connection ? repoText.connectedAs(repo.connection.login) : repoText.byLink}
        </Typography>
      </Box>
      <Button
        size="small"
        component="a"
        href={repo.webUrl}
        target="_blank"
        rel="noreferrer noopener"
        sx={{ minHeight: 44 }}
      >
        {runText.openAt(label)}
      </Button>
      {/* «Выкатить» (ПР15): a manual job or a `workflow_dispatch` of the head of the main branch,
          by the author's connection. */}
      {repo.mode === 'write' &&
      repo.connection?.state === 'ok' &&
      repoOffersDeploy(repoProviderOffers[repo.provider]) ? (
        <DeployButton projectId={project.id} />
      ) : null}
    </Box>
  )
}

type RunsFilter = 'all' | 'failed' | 'going'

function Tabs<T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  value: T
  items: readonly { id: T; label: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <Box role="tablist" aria-label={label} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {items.map((item) => (
        <ButtonBase
          key={item.id}
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          sx={{
            minHeight: 44,
            px: 1.75,
            borderRadius: '10px',
            fontSize: 14,
            fontWeight: value === item.id ? 600 : 400,
            color: value === item.id ? 'text.primary' : 'text.secondary',
            bgcolor: value === item.id ? 'action.selected' : 'transparent',
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
          }}
        >
          {item.label}
        </ButtonBase>
      ))}
    </Box>
  )
}

/** P-repo: the card of the repository and its builds, merge requests and branches of the agent. */
export function RepositoryView({
  project,
}: {
  project: Pick<ProjectDetails, 'id' | 'name' | 'repository'>
}) {
  const trpc = useTRPC()
  const [tab, setTab] = useState<'runs' | 'requests' | 'branches'>('runs')
  const work = useQuery(trpc.projectRepo.work.queryOptions({ projectId: project.id }))
  // The tabs of merge requests and branches say they load or failed (ревью P7).
  const workState = work.error ? (
    <Alert
      severity="error"
      action={
        <Button
          color="inherit"
          size="small"
          onClick={() => void work.refetch()}
          sx={{ minHeight: 44 }}
        >
          {runText.retry}
        </Button>
      }
    >
      {callErrorText(work.error)}
    </Alert>
  ) : work.data ? null : (
    <Typography role="status" sx={{ color: 'text.secondary' }}>
      {runText.workLoading}
    </Typography>
  )
  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 1200,
        mx: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <BackLink href={`/projects/${project.id}`}>{runText.back}</BackLink>
      <RepositoryCard project={project} />
      <Tabs
        label={runText.title}
        value={tab}
        onChange={setTab}
        items={[
          { id: 'runs', label: runText.runs },
          { id: 'requests', label: runText.requests(work.data?.mergeRequests.length ?? 0) },
          { id: 'branches', label: runText.branches(work.data?.branches.length ?? 0) },
        ]}
      />
      {tab === 'runs' ? <RunsList projectId={project.id} /> : null}
      {tab === 'requests' ? (
        <Box sx={card}>
          {workState ??
            (work.data && work.data.mergeRequests.length > 0 ? (
              <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1.5 }}>
                {work.data.mergeRequests.map((mr) => (
                  <Box
                    component="li"
                    key={mr.number}
                    sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
                  >
                    <Link href={mr.url} target="_blank" rel="noreferrer">
                      {mr.title}
                    </Link>
                    <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                      {pullRequestStateWords[mr.state]} · {checksStateWords[mr.checks]}
                      {mr.chat ? ` · ${runText.fromChat(mr.chat.title)}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Box>
            ) : (
              <Typography sx={{ color: 'text.secondary' }}>{runText.noRequests}</Typography>
            ))}
        </Box>
      ) : null}
      {tab === 'branches' ? (
        <Box sx={card}>
          {workState ??
            (work.data && work.data.branches.length > 0 ? (
              <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1.5 }}>
                {work.data.branches.map((branch) => (
                  <Box
                    component="li"
                    key={branch.branch}
                    sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
                  >
                    <Typography sx={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14 }}>
                      {branch.branch}
                    </Typography>
                    <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                      {repoBranchStateWords[branch.state]} ·{' '}
                      <Link href={`/chats/${branch.chat.id}`}>
                        {runText.fromChat(branch.chat.title)}
                      </Link>
                    </Typography>
                  </Box>
                ))}
              </Box>
            ) : (
              <Typography sx={{ color: 'text.secondary' }}>{runText.noBranches}</Typography>
            ))}
        </Box>
      ) : null}
    </Box>
  )
}

/** «Сборки (CI/CD)»: the newest first, filtered, read again while one goes. */
function RunsList({ projectId }: { projectId: string }) {
  const trpc = useTRPC()
  const [filter, setFilter] = useState<RunsFilter>('all')
  const [pages, setPages] = useState<Date[]>([])
  const first = useQuery({
    ...trpc.projectRepo.runs.queryOptions({ projectId }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      return data.refreshing || data.items.some((run) => active(run.status)) ? RUNS_POLL_MS : false
    },
  })
  const runs = first.data?.items ?? []
  const shown = runs.filter((run) =>
    filter === 'failed' ? run.status === 'failed' : filter === 'going' ? active(run.status) : true,
  )
  const failed = runs.filter((run) => run.status === 'failed').length
  const going = runs.filter((run) => active(run.status)).length
  return (
    <Box sx={{ ...card, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Tabs
        label={runText.runs}
        value={filter}
        onChange={setFilter}
        items={[
          { id: 'all', label: runText.all },
          { id: 'failed', label: `${runText.failed} ${failed}` },
          { id: 'going', label: `${runText.going} ${going}` },
        ]}
      />
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{runText.stagesNote}</Typography>
      {first.error ? <Alert severity="error">{callErrorText(first.error)}</Alert> : null}
      {first.data && runs.length === 0 ? (
        <Typography sx={{ color: 'text.secondary' }}>
          {first.data.refreshing || first.data.polledAt === null ? runText.reading : runText.none}
        </Typography>
      ) : null}
      <Box component="ul" data-repo-runs="" sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {shown.map((run) => (
          <RunRow key={run.id} projectId={projectId} run={run} />
        ))}
        {pages.map((before) => (
          <RunsPage
            key={before.toISOString()}
            projectId={projectId}
            before={before}
            filter={filter}
          />
        ))}
      </Box>
      {first.data?.next && pages.length === 0 ? (
        <Box>
          <Button size="small" onClick={() => setPages([first.data!.next!])} sx={{ minHeight: 44 }}>
            {runText.more}
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}

function RunsPage({
  projectId,
  before,
  filter,
}: {
  projectId: string
  before: Date
  filter: RunsFilter
}) {
  const trpc = useTRPC()
  const page = useQuery(trpc.projectRepo.runs.queryOptions({ projectId, cursor: before }))
  return (
    <>
      {(page.data?.items ?? [])
        .filter((run) =>
          filter === 'failed'
            ? run.status === 'failed'
            : filter === 'going'
              ? active(run.status)
              : true,
        )
        .map((run) => (
          <RunRow key={run.id} projectId={projectId} run={run} />
        ))}
    </>
  )
}

interface RunRowData {
  id: string
  name: string
  ref: string
  status: CiStatus
  refusal: CiRefusal | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  chat: { id: string; title: string | null } | null
  stages: string[]
}

function RunRow({ projectId, run }: { projectId: string; run: RunRowData }) {
  return (
    <Box
      component="li"
      data-repo-run={run.id}
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '200px minmax(0, 1fr) 180px 110px 120px' },
        gap: { xs: 0.5, md: 2 },
        alignItems: 'center',
        py: 1.5,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <CiStatusChip status={run.status} refusal={run.refusal} />
      <Box sx={{ minWidth: 0 }}>
        <Box
          component={Link}
          href={runHref(projectId, run.id)}
          sx={{ color: 'text.primary', fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}
        >
          {run.name}
        </Box>
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', overflowWrap: 'anywhere' }}>
          #{run.id} ·{' '}
          <Box component="span" sx={{ fontFamily: 'var(--font-mono, monospace)' }}>
            {run.ref}
          </Box>
          {run.chat ? ` · ${runText.fromChat(run.chat.title)}` : ''}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: 13, color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {run.stages.join(' · ')}
      </Typography>
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
        {durationOf(run.startedAt, run.finishedAt) ?? '—'}
      </Typography>
      <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
        {whenOf(run.createdAt)}
      </Typography>
    </Box>
  )
}

/** P-pipeline: a build, its stages and jobs, and the log of a job across the whole width. */
export function RunView({
  project,
  runId,
}: {
  project: Pick<ProjectDetails, 'id' | 'name' | 'repository'>
  runId: string
}) {
  const trpc = useTRPC()
  const query = useQuery({
    ...trpc.projectRepo.run.queryOptions({ projectId: project.id, runId }),
    refetchInterval: (state) =>
      state.state.data && active(state.state.data.run.status) ? RUNS_POLL_MS : false,
  })
  const [open, setOpen] = useState<RepoCiJob | null>(null)
  const label = repoProviderBrands[project.repository?.provider ?? 'gitlab'].label
  const data = query.data
  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 1200,
        mx: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <BackLink href={repositoryHref(project.id)}>{runText.allRuns}</BackLink>
      {query.error ? <Alert severity="error">{callErrorText(query.error)}</Alert> : null}
      {data ? (
        <>
          <Box sx={{ ...card, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
              <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
                {runText.run(data.run.id)}
              </Typography>
              <CiStatusChip status={data.run.status} refusal={data.run.refusal} />
              <Box sx={{ flex: '1 1 auto' }} />
              <Button
                size="small"
                component="a"
                href={data.run.url}
                target="_blank"
                rel="noreferrer noopener"
                sx={{ minHeight: 44 }}
              >
                {runText.openAt(label)}
              </Button>
            </Box>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', overflowWrap: 'anywhere' }}>
              <Box component="span" sx={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {data.run.ref} · {data.run.sha.slice(0, 7)}
              </Box>{' '}
              · {data.run.name}
              {data.run.chat ? (
                <>
                  {' · '}
                  <Link href={`/chats/${data.run.chat.id}`}>
                    {runText.fromChat(data.run.chat.title)}
                  </Link>
                </>
              ) : null}
              {' · '}
              {runText.ranFor(
                whenOf(data.run.createdAt),
                durationOf(data.run.startedAt, data.run.finishedAt),
              )}
            </Typography>
            {data.run.refusal ? (
              <Alert severity="warning">{ciRefusalTexts[data.run.refusal]}</Alert>
            ) : null}
          </Box>
          <Stages jobs={data.jobs} openId={open?.id ?? null} onOpen={setOpen} />
          {open ? (
            <JobLog
              key={open.id}
              projectId={project.id}
              runId={data.run.id}
              job={open}
              label={label}
              onClose={() => setOpen(null)}
            />
          ) : null}
        </>
      ) : null}
    </Box>
  )
}

function Stages({
  jobs,
  openId,
  onOpen,
}: {
  jobs: readonly RepoCiJob[]
  openId: string | null
  onOpen: (job: RepoCiJob) => void
}) {
  const stages = ciStagesOf(jobs)
  if (stages.length === 0)
    return (
      <Box sx={card}>
        <Typography sx={{ color: 'text.secondary' }}>{runText.noJobs}</Typography>
      </Box>
    )
  return (
    <Box
      data-repo-stages=""
      sx={{
        display: 'grid',
        gap: 1.5,
        gridTemplateColumns: {
          xs: '1fr',
          sm: 'repeat(2, minmax(0, 1fr))',
          lg: 'repeat(4, minmax(0, 1fr))',
        },
      }}
    >
      {stages.map((stage) => (
        <Box
          key={stage.name ?? '—'}
          sx={{ ...card, display: 'flex', flexDirection: 'column', gap: 1 }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
            <Typography sx={{ fontWeight: 600, fontSize: 14, overflowWrap: 'anywhere' }}>
              {stage.name ?? '—'}
            </Typography>
            <CiStatusChip status={stage.status} />
          </Box>
          {stage.jobs.map((job) => (
            <ButtonBase
              key={job.id}
              data-repo-job={job.id}
              aria-pressed={openId === job.id}
              onClick={() => onOpen(job)}
              sx={{
                minHeight: 44,
                px: 1,
                borderRadius: '8px',
                justifyContent: 'space-between',
                gap: 1,
                textAlign: 'left',
                bgcolor: openId === job.id ? 'action.selected' : 'transparent',
                '&:hover': { bgcolor: 'action.hover' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
              }}
            >
              <Typography
                sx={{
                  fontSize: 13.5,
                  fontFamily: 'var(--font-mono, monospace)',
                  overflowWrap: 'anywhere',
                }}
              >
                {job.name}
              </Typography>
              <Typography sx={{ fontSize: 12.5, color: 'text.secondary', flex: 'none' }}>
                {ciWord(job.status, job.refusal)}
                {durationOf(job.startedAt, job.finishedAt)
                  ? ` · ${durationOf(job.startedAt, job.finishedAt)}`
                  : ''}
              </Typography>
            </ButtonBase>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** The log of a job: core fetches it on the first look (`loading`), then the masked tail. */
export function JobLog({
  projectId,
  runId,
  job,
  label,
  onClose,
}: {
  projectId: string
  runId: string
  job: RepoCiJob
  label: string
  onClose: () => void
}) {
  const trpc = useTRPC()
  const [shown, setShown] = useState(false)
  const log = useQuery({
    ...trpc.projectRepo.jobLog.queryOptions({ projectId, runId, jobId: job.id }),
    enabled: shown,
    refetchInterval: (query) =>
      query.state.data?.state === 'loading'
        ? LOG_POLL_MS
        : query.state.data?.state === 'ready' && active(job.status)
          ? RUNS_POLL_MS
          : false,
  })
  const data = log.data
  return (
    <Box data-repo-log={job.id} sx={{ ...card, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Typography component="h2" sx={{ fontWeight: 600, fontSize: 15 }}>
          {runText.log(job.name)}
        </Typography>
        {job.stage ? (
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
            {runText.stage(job.stage)}
          </Typography>
        ) : null}
        <Box sx={{ flex: '1 1 auto' }} />
        {data?.state === 'ready' && data.truncated ? (
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            {runText.logTail}
          </Typography>
        ) : null}
        <Button
          size="small"
          component="a"
          href={job.url}
          target="_blank"
          rel="noreferrer noopener"
          sx={{ minHeight: 44 }}
        >
          {runText.openAt(label)}
        </Button>
        <Button
          size="small"
          color="inherit"
          onClick={() => (shown ? onClose() : setShown(true))}
          sx={{ minHeight: 44 }}
        >
          {shown ? runText.hideLog : runText.openLog}
        </Button>
      </Box>
      {job.refusal ? <Alert severity="warning">{ciRefusalTexts[job.refusal]}</Alert> : null}
      {shown ? (
        log.error ? (
          <Alert severity="error">{callErrorText(log.error)}</Alert>
        ) : !data || data.state === 'loading' ? (
          <Typography role="status" sx={{ color: 'text.secondary', fontSize: 14 }}>
            {runText.logLoading}
          </Typography>
        ) : data.state === 'failed' ? (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={() => void log.refetch()}>
                {runText.retry}
              </Button>
            }
          >
            {runText.logFailed}
          </Alert>
        ) : (
          <>
            <Box
              component="pre"
              data-repo-log-text=""
              sx={{
                m: 0,
                p: 1.5,
                maxHeight: '70vh',
                overflow: 'auto',
                borderRadius: '10px',
                bgcolor: 'action.hover',
                fontSize: 12.5,
                lineHeight: '19px',
                fontFamily: 'var(--font-mono, monospace)',
                whiteSpace: 'pre',
              }}
            >
              {data.text || runText.logEmpty}
            </Box>
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
              {runText.logAsIs}
            </Typography>
          </>
        )
      ) : null}
    </Box>
  )
}

/**
 * The state of the repository under its row in «Контекст»: the newest build and a link to
 * «Репозиторий, сборки»; read again while a build goes.
 */
export function RepositoryRunsLine({ projectId }: { projectId: string }) {
  const trpc = useTRPC()
  const runs = useQuery({
    ...trpc.projectRepo.runs.queryOptions({ projectId, limit: 1 }),
    refetchInterval: (query) => {
      const data = query.state.data
      return data && (data.refreshing || data.items.some((run) => active(run.status)))
        ? RUNS_POLL_MS
        : false
    },
  })
  const last = runs.data?.items[0] ?? null
  return (
    <Box
      data-repo-runs-line=""
      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}
    >
      {last ? (
        <>
          <Typography component="span" sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            {runText.lastRun}:
          </Typography>
          <CiStatusChip status={last.status} refusal={last.refusal} />
        </>
      ) : null}
      <Box
        component={Link}
        href={repositoryHref(projectId)}
        sx={{
          fontSize: 13,
          color: 'primary.main',
          minHeight: 44,
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {runText.allRunsLink}
      </Box>
    </Box>
  )
}
