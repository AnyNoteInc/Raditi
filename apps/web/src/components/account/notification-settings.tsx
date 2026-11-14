'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'

import { useTRPC } from '@/trpc/client'

// «Уведомления» of the settings (docs/plan/75-chat-input-output.md, ВВ8, ВВ10): letters about the
// work of the agent (on by default) and notifications in this browser (off until the client turns
// them on here, which asks the browser's permission). A notification comes only when the client is
// not looking at the chat.

export const notificationText = Object.freeze({
  title: 'Уведомления',
  hint: 'Когда агент закончит работу, задаст вопрос или остановится, а вы не смотрите на чат.',
  push: 'В этом браузере',
  pushHint: 'Уведомление на экране компьютера или телефона.',
  pushUnsupported: 'Этот браузер не показывает уведомления сайтов.',
  pushUnavailable: 'Уведомления в браузере пока не настроены.',
  pushDenied:
    'Браузер запретил уведомления для Радити. Разрешите их в настройках сайта в браузере и включите снова.',
  email: 'Письма о работе агента',
  emailHint: 'Письмо на почту, не чаще одного в полчаса по одному чату.',
  failed: 'Не удалось сохранить настройку. Попробуйте ещё раз.',
  loading: 'Загружаем настройки уведомлений',
})

/** The key of VAPID, URL-safe base64, as `PushManager.subscribe` takes it. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

const pushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** The subscription of this browser, made with the key of the platform. */
async function subscribeHere(publicKey: string) {
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }))
  const json = subscription.toJSON()
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  }
}

async function unsubscribeHere(): Promise<string | null> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return null
  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  return endpoint
}

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
  const subscribe = useMutation(trpc.notification.subscribe.mutationOptions())
  const unsubscribe = useMutation(trpc.notification.unsubscribe.mutationOptions())
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const ids = { push: useId(), pushHint: useId(), email: useId(), emailHint: useId() }
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.notification.settings.queryKey() })

  async function togglePush(on: boolean) {
    setProblem(null)
    const publicKey = settings.data?.publicKey
    if (!pushSupported()) return setProblem(notificationText.pushUnsupported)
    if (!publicKey) return setProblem(notificationText.pushUnavailable)
    setWorking(true)
    try {
      if (on) {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') return setProblem(notificationText.pushDenied)
        await subscribe.mutateAsync(await subscribeHere(publicKey))
      } else {
        const endpoint = await unsubscribeHere()
        if (endpoint) await unsubscribe.mutateAsync({ endpoint })
        await save.mutateAsync({ push: false })
      }
    } catch {
      setProblem(notificationText.failed)
    } finally {
      setWorking(false)
      refresh()
    }
  }

  async function toggleEmail(on: boolean) {
    setProblem(null)
    try {
      await save.mutateAsync({ email: on })
    } catch {
      setProblem(notificationText.failed)
    }
    refresh()
  }

  return (
    <Box component="section" aria-labelledby="notifications-title" sx={{ p: { xs: 2.5, sm: 4 } }}>
      <Typography id="notifications-title" component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
        {notificationText.title}
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mt: 0.5, maxWidth: 520 }}>
        {notificationText.hint}
      </Typography>
      {settings.isPending ? (
        <Box role="status" aria-label={notificationText.loading}>
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
        </Box>
      ) : (
        <>
          <Row
            label={{ id: ids.push, text: notificationText.push }}
            hint={{ id: ids.pushHint, text: notificationText.pushHint }}
            control={
              <Switch
                checked={(settings.data?.push ?? false) && (settings.data?.browsers ?? 0) > 0}
                disabled={working || settings.isError}
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
      {problem ? (
        <Alert role="alert" severity="warning" sx={{ mt: 2 }}>
          {problem}
        </Alert>
      ) : null}
    </Box>
  )
}
