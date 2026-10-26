'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import type { AppRouter } from '@repo/trpc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import type { ProjectStack } from '@/components/projects/project-labels'
import {
  callErrorText,
  domainCodeOf,
  type CallError,
} from '@/components/projects/wizard/reason-text'
import { useTRPC } from '@/trpc/client'

import { ReplaceAccessForm } from './replace-access'
import { SectionTitle } from './section-empty'
import { RETRIES_PER_HOUR, setupErrorText, setupStageText } from './setup-text'
import { SiteCard } from './site-cards'

/** What `siteConnection.setup` answers: the first import of the site and what may be done about it. */
export type SiteSetupState = inferRouterOutputs<AppRouter>['siteConnection']['setup']

/** How often the screen asks while the import has no outcome. */
export const SETUP_POLL_MS = 3_000

const HEADLINE = 'site-setup-headline'
const REPLACE_ACCESS = 'site-setup-replace-access'

/** A poll that will never succeed again: the session ended, or the site is not the user's any more. */
const lostForGood = (error: unknown) =>
  ['UNAUTHORIZED', 'NOT_FOUND'].includes((error as CallError | null)?.data?.code ?? '')

/** Refusals of «Повторить» that mean the screen is behind the server: another tab or member acted. */
const staleRetryCodes = new Set(['SITE_SETUP_NOT_FAILED', 'SITE_SETUP_UNAVAILABLE'])

type Mark = 'done' | 'current' | 'later'

/** Where the import is, as three marks: done, now, later. No percentages: there is no honest one. */
function SetupSteps({ status, step }: { status: string | null; step: string | null }) {
  const publishing = status === 'running' && step === 'publish'
  const fetching = status === 'running' && !publishing
  const items: readonly { label: string; mark: Mark }[] = [
    { label: 'Проект добавлен', mark: 'done' },
    { label: 'Копируем файлы сайта', mark: publishing ? 'done' : fetching ? 'current' : 'later' },
    { label: 'Сохраняем первоначальную версию', mark: publishing ? 'current' : 'later' },
  ]
  return (
    <Box
      component="ol"
      aria-label="Этапы настройки"
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1.25 }}
    >
      {items.map((item) => (
        <Box
          component="li"
          key={item.label}
          aria-current={item.mark === 'current' ? 'step' : undefined}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            minHeight: 28,
            color: item.mark === 'later' ? 'text.secondary' : 'text.primary',
            fontWeight: item.mark === 'current' ? 600 : 400,
          }}
        >
          <Box
            component="span"
            sx={{
              width: 24,
              height: 24,
              flex: 'none',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: item.mark === 'done' ? 0 : '2px solid',
              borderColor: item.mark === 'current' ? 'primary.main' : 'divider',
              bgcolor: item.mark === 'done' ? 'primary.main' : 'transparent',
              color: 'primary.contrastText',
            }}
          >
            {item.mark === 'done' ? (
              <AppIcon name="check" size={14} style={{ strokeWidth: 2.4 }} />
            ) : item.mark === 'current' ? (
              <Box
                component="span"
                sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main' }}
              />
            ) : null}
          </Box>
          <span>{item.label}</span>
        </Box>
      ))}
    </Box>
  )
}

/** Motion that says «still working»; without motion, a still track says the same. */
function Working() {
  return (
    <LinearProgress
      aria-hidden
      sx={{
        height: 4,
        borderRadius: 999,
        '@media (prefers-reduced-motion: reduce)': {
          '& .MuiLinearProgress-bar': {
            animation: 'none',
            transform: 'none',
            left: 0,
            right: 0,
            width: '100%',
            opacity: 0.35,
          },
          '& .MuiLinearProgress-bar2': { display: 'none' },
        },
      }}
    />
  )
}

/**
 * «Настраиваем сайт»: the page of a site whose first import has not succeeded. It asks the
 * server every few seconds while the import waits or runs, and stops on an outcome; the outcome
 * `done` renders the page anew on the server, whose shell then opens every section. One live
 * region says where the import is, so each change is heard once.
 */
export function SiteSetup({
  siteId,
  stack,
  platform,
  initial,
}: {
  siteId: string
  stack: ProjectStack
  platform: string
  /** What the server rendered the page with; the screen asks anew at once. */
  initial?: SiteSetupState
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [replacing, setReplacing] = useState(false)
  /** «Новый доступ сохранён.», of the attempt that the replaced access ended: never of a later one. */
  const [notice, setNotice] = useState<{ attempt: number | null; text: string } | null>(null)
  /**
   * The id of the element the focus goes to after the next render: the headline after «Повторить»
   * and a replaced access, whose buttons are gone; «Изменить доступ» after «Отмена».
   */
  const focusNext = useRef<string | null>(null)
  const setupKey = trpc.siteConnection.setup.queryKey({ id: siteId })
  /** The chip of the project in the list names the state of its setup. */
  const refreshList = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })

  const setup = useQuery(
    trpc.siteConnection.setup.queryOptions(
      { id: siteId },
      {
        initialData: initial,
        staleTime: 0,
        // A failure and a success are an end: nothing changes there until the user acts. Neither
        // does a session that ended or a site that is gone: asking again only fails again.
        refetchInterval: (query) =>
          query.state.data?.state === 'pending' && !lostForGood(query.state.error)
            ? SETUP_POLL_MS
            : false,
        refetchOnWindowFocus: (query) =>
          query.state.data?.state === 'pending' && !lostForGood(query.state.error)
            ? 'always'
            : false,
      },
    ),
  )
  const retry = useMutation(trpc.siteConnection.retry.mutationOptions())

  function tryAgain() {
    retry.mutate(
      { id: siteId },
      {
        // The answer is the new attempt: the screen follows it from here.
        onSuccess: (next) => {
          setNotice(null)
          focusNext.current = HEADLINE
          queryClient.setQueryData(setupKey, next)
          refreshList()
        },
        // The import is no longer the failed one this screen shows: ask where it is now.
        onError: (error) => {
          if (staleRetryCodes.has(domainCodeOf(error) ?? '')) {
            void queryClient.invalidateQueries({ queryKey: setupKey })
          }
        },
      },
    )
  }

  const data = setup.data
  const state = data?.state
  useEffect(() => {
    // The server renders the page anew: the shell with every section, and «Обзор» itself.
    if (state !== 'done') return
    router.refresh()
    void queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
  }, [state, router, queryClient, trpc])
  useEffect(() => {
    const id = focusNext.current
    if (id === null) return
    focusNext.current = null
    document.getElementById(id)?.focus()
  })

  const failed = data?.state === 'failed'
  /** No answer of the server about an import that has no outcome: its last state may be long gone. */
  const unknown = setup.isError && (data === undefined || data.state === 'pending')
  const pending = data?.state === 'pending' && !unknown
  const stage = setupStageText(data ?? { status: null, step: null })
  const headline = unknown
    ? 'Не удалось узнать, как идёт настройка'
    : data === undefined
      ? 'Узнаём, как идёт настройка…'
      : data.state === 'done'
        ? 'Настройка завершена. Открываем обзор сайта…'
        : failed
          ? 'Настройка остановилась'
          : stage.title
  const shownNotice = failed && notice?.attempt === data.attempt ? notice.text : null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <Box>
        <SectionTitle>Настраиваем сайт</SectionTitle>
        <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 720, textWrap: 'pretty' }}>
          Копируем файлы сайта и сохраняем его первоначальную версию. Страницу можно закрыть —
          настройка продолжится без вас.
        </Typography>
      </Box>

      <SiteCard title="Состояние настройки">
        <Box
          sx={{
            px: { xs: 2, sm: 2.75 },
            py: 2.25,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {/* The one live region: the headline, and on a failure its reason. */}
          <Box role="status" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography
              id={HEADLINE}
              tabIndex={-1}
              sx={{ fontWeight: 600, fontSize: 17, outline: 'none' }}
            >
              {headline}
            </Typography>
            {failed ? (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Box sx={{ color: 'error.main', display: 'flex', mt: '2px' }}>
                  <AppIcon name="warning" size={18} />
                </Box>
                <Typography sx={{ overflowWrap: 'anywhere' }}>
                  {setupErrorText(data.errorCode, {
                    kind: data.source?.kind ?? 'sftp',
                    platform,
                  })}
                </Typography>
              </Box>
            ) : null}
            {shownNotice ? (
              <Typography color="success.main" sx={{ fontWeight: 500 }}>
                {shownNotice}
              </Typography>
            ) : null}
          </Box>

          {pending ? (
            <>
              <Working />
              <Typography color="text.secondary">{stage.note}</Typography>
              <SetupSteps status={data.status} step={data.step} />
            </>
          ) : null}

          {failed && data.retry === 'limited' ? (
            <Typography variant="body2" color="text.secondary">
              Повторить настройку или изменить доступ можно {RETRIES_PER_HOUR} раз в час. Попробуйте
              немного позже.
            </Typography>
          ) : null}
          {failed && retry.isError ? (
            <Alert severity="error">
              {callErrorText(retry.error, {
                invalid: 'Не удалось повторить настройку. Обновите страницу.',
                failed: 'Не удалось повторить настройку. Попробуйте ещё раз.',
              })}
            </Alert>
          ) : null}
          {/* A used-up hour leaves only its phrase: the server would refuse either button. */}
          {failed &&
          !replacing &&
          data.retry !== 'limited' &&
          (data.retry === 'available' || data.replaceAccess) ? (
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1.5 }}>
              {data.retry === 'available' ? (
                <Button
                  variant="contained"
                  startIcon={<AppIcon name="retry" size={18} />}
                  loading={retry.isPending}
                  loadingPosition="start"
                  onClick={tryAgain}
                >
                  Повторить
                </Button>
              ) : null}
              {data.replaceAccess ? (
                <Button
                  id={REPLACE_ACCESS}
                  variant="outlined"
                  color="inherit"
                  disabled={retry.isPending}
                  onClick={() => {
                    retry.reset()
                    setNotice(null)
                    setReplacing(true)
                  }}
                >
                  Изменить доступ
                </Button>
              ) : null}
            </Box>
          ) : null}

          {unknown ? (
            <Box>
              <Button
                variant="outlined"
                color="inherit"
                // A session that ended or a site that is gone: the server says so on the page itself.
                onClick={() => (lostForGood(setup.error) ? router.refresh() : void setup.refetch())}
              >
                Обновить
              </Button>
            </Box>
          ) : null}
        </Box>
      </SiteCard>

      {failed && replacing ? (
        <Box
          sx={{ border: 1, borderColor: 'divider', borderRadius: '14px', p: { xs: 2, sm: 2.75 } }}
        >
          <ReplaceAccessForm
            siteId={siteId}
            stack={stack}
            platform={platform}
            saved={data.source}
            onCancel={() => {
              setReplacing(false)
              focusNext.current = REPLACE_ACCESS
            }}
            onReplaced={() => {
              setReplacing(false)
              setNotice({ attempt: data.attempt, text: 'Новый доступ сохранён.' })
              focusNext.current = HEADLINE
              void queryClient.invalidateQueries({ queryKey: setupKey })
              refreshList()
            }}
          />
        </Box>
      ) : null}
    </Box>
  )
}
