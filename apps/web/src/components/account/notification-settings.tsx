'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'

import {
  browserPushStateText,
  browserPushText,
  useBrowserPush,
} from '@/components/notifications/use-browser-push'
import { useTRPC } from '@/trpc/client'

// «Уведомления» of the settings (docs/plan/75-chat-input-output.md, ВВ8, ВВ10): letters about the
// work of the agent (on by default) and notifications in this browser (off until the client turns
// them on here, which asks the browser's permission). A notification comes only when the client is
// not looking at the chat. The switch is of this browser only (docs/plan/82-scheduled-tasks.md,
// Зп37): turning it off takes this browser's subscription away and leaves the others, which the
// line «Ещё в N браузерах» counts.

export const notificationText = Object.freeze({
  title: 'Уведомления',
  hint: 'Когда агент закончит работу, задаст вопрос или остановится, а вы не смотрите на чат.',
  push: 'В этом браузере',
  pushHint: 'Уведомление на экране компьютера или телефона.',
  email: 'Письма о работе агента',
  emailHint: 'Письмо на почту, не чаще одного в полчаса по одному чату.',
  failed: 'Не удалось сохранить настройку. Попробуйте ещё раз.',
  loading: 'Загружаем настройки уведомлений',
})

function Row({
  label,
  hint,
  control,
}: {
  label: { id: string; text: string }
  hint: { id: string; text: ReactNode }
  control: ReactNode
}) {
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mt: 2 }}
    >
      <Box sx={{ maxWidth: 520 }}>
        <Typography id={label.id} sx={{ fontWeight: 500, fontSize: 15 }}>
          {label.text}
        </Typography>
        <Typography id={hint.id} color="text.secondary" variant="body2" sx={{ mt: 0.25 }}>
          {hint.text}
        </Typography>
      </Box>
      {control}
    </Stack>
  )
}

const switchSx = {
  mt: -0.5,
  mr: -1,
  flexShrink: 0,
  height: 44,
  py: '15px',
  '& .MuiSwitch-switchBase': { top: 3 },
} as const

export function NotificationSettings() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settings = useQuery(trpc.notification.settings.queryOptions())
  const save = useMutation(trpc.notification.setSettings.mutationOptions())
  const push = useBrowserPush()
  const [problem, setProblem] = useState<string | null>(null)
  const ids = { push: useId(), pushHint: useId(), email: useId(), emailHint: useId() }

  async function togglePush(on: boolean) {
    setProblem(null)
    if (on) await push.enable()
    else await push.disable()
  }

  async function toggleEmail(on: boolean) {
    setProblem(null)
    try {
      await save.mutateAsync({ email: on })
    } catch {
      setProblem(notificationText.failed)
    }
    void queryClient.invalidateQueries({ queryKey: trpc.notification.settings.queryKey() })
  }

  const stateText = browserPushStateText(push.state, push.device)
  const others = push.otherBrowsers ?? 0
  const shownProblem = problem ?? push.problem

  return (
    <Box component="section" aria-labelledby="notifications-title" sx={{ p: { xs: 2.5, sm: 4 } }}>
      <Typography id="notifications-title" component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
        {notificationText.title}
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mt: 0.5, maxWidth: 520 }}>
        {notificationText.hint}
      </Typography>
      {settings.isPending || push.state === 'loading' ? (
        <Box role="status" aria-label={notificationText.loading}>
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
        </Box>
      ) : (
        <>
          <Row
            label={{ id: ids.push, text: notificationText.push }}
            hint={{
              id: ids.pushHint,
              text: (
                <>
                  {stateText ?? notificationText.pushHint}
                  {others > 0 ? (
                    <>
                      {' '}
                      <Box component="span" sx={{ display: 'block', mt: 0.5 }}>
                        {browserPushText.otherBrowsers(others)}
                      </Box>
                    </>
                  ) : null}
                </>
              ),
            }}
            control={
              <Switch
                checked={push.state === 'on'}
                disabled={push.working || (push.state !== 'on' && push.state !== 'off')}
                onChange={(_event, on) => void togglePush(on)}
                slotProps={{
                  input: { 'aria-labelledby': ids.push, 'aria-describedby': ids.pushHint },
                }}
                sx={switchSx}
              />
            }
          />
          <Row
            label={{ id: ids.email, text: notificationText.email }}
            hint={{ id: ids.emailHint, text: notificationText.emailHint }}
            control={
              <Switch
                checked={settings.data?.email ?? true}
                disabled={save.isPending || settings.isError}
                onChange={(_event, on) => void toggleEmail(on)}
                slotProps={{
                  input: { 'aria-labelledby': ids.email, 'aria-describedby': ids.emailHint },
                }}
                sx={switchSx}
              />
            }
          />
        </>
      )}
      {shownProblem ? (
        <Alert role="alert" severity="warning" sx={{ mt: 2 }}>
          {shownProblem}
        </Alert>
      ) : null}
    </Box>
  )
}
