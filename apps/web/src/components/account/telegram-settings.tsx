'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'

import { useTRPC } from '@/trpc/client'

// «Telegram» of the settings (docs/plan/80-telegram.md, Т1, Т3, Т8): the client links Telegram by
// a one-time link to the bot, is told before that the words pass through Telegram — a service
// abroad — and chooses whether the bot tells of the chats of the cabinet.

export const telegramSettingsText = Object.freeze({
  title: 'Telegram',
  hint: 'Пишите агенту из Telegram: сообщения, голосовые, фото и файлы. Ответы придут туда же, чаты видны и здесь.',
  abroad:
    'Сообщения, файлы и ответы агента в Telegram проходят через серверы Telegram — это иностранный сервис. Копия чата хранится у нас, в России.',
  link: 'Подключить',
  linkAgain: 'Получить новую ссылку',
  opened: (minutes: number) =>
    `Откройте ссылку и нажмите «Запустить» в Telegram. Ссылка действует ${minutes} минут и только один раз.`,
  openLink: 'Открыть бота',
  linked: (username: string | null) =>
    username === null ? 'Telegram подключён.' : `Telegram подключён: @${username}.`,
  notify: 'Уведомления в Telegram',
  notifyHint: 'Бот напишет, когда агент ответит в чате кабинета, а вы не смотрите на чат.',
  unlink: 'Отключить',
  failed: 'Не удалось сохранить. Попробуйте ещё раз.',
  tooMany: 'Ссылок за час получено слишком много. Попробуйте позже.',
  loading: 'Загружаем настройки Telegram',
})

const LINK_MINUTES = 15

export function TelegramSettings() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [link, setLink] = useState<string | null>(null)
  const status = useQuery({
    ...trpc.telegram.status.queryOptions(),
    // While a link waits, the page looks for the press of «Запустить» in Telegram.
    refetchInterval: (query) => (link !== null && !query.state.data?.linked ? 3_000 : false),
  })
  const start = useMutation(trpc.telegram.link.mutationOptions())
  const unlink = useMutation(trpc.telegram.unlink.mutationOptions())
  const notify = useMutation(trpc.telegram.setNotifications.mutationOptions())
  const [problem, setProblem] = useState<string | null>(null)
  const ids = { notify: useId(), notifyHint: useId() }
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.telegram.status.queryKey() })

  if (status.data && !status.data.available) return null

  async function startLink() {
    setProblem(null)
    try {
      const made = await start.mutateAsync()
      setLink(made.url)
      window.open(made.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setProblem(
        error instanceof Error && /много/u.test(error.message)
          ? telegramSettingsText.tooMany
          : telegramSettingsText.failed,
      )
    }
  }

  async function stop() {
    setProblem(null)
    try {
      await unlink.mutateAsync()
      setLink(null)
    } catch {
      setProblem(telegramSettingsText.failed)
    }
    refresh()
  }

  async function toggle(on: boolean) {
    setProblem(null)
    try {
      await notify.mutateAsync({ on })
    } catch {
      setProblem(telegramSettingsText.failed)
    }
    refresh()
  }

  const linked = status.data?.linked ?? null
  return (
    <Box component="section" aria-labelledby="telegram-title" sx={{ p: { xs: 2.5, sm: 4 } }}>
      <Typography id="telegram-title" component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
        {telegramSettingsText.title}
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mt: 0.5, maxWidth: 520 }}>
        {telegramSettingsText.hint}
      </Typography>
      {status.isPending ? (
        <Box role="status" aria-label={telegramSettingsText.loading}>
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
        </Box>
      ) : linked ? (
        <>
          <Stack
            direction="row"
            spacing={2}
            sx={{ mt: 2, alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Typography sx={{ fontSize: 15 }}>
              {telegramSettingsText.linked(linked.username)}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              disabled={unlink.isPending}
              onClick={() => void stop()}
            >
              {telegramSettingsText.unlink}
            </Button>
          </Stack>
          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mt: 2 }}
          >
            <Box sx={{ maxWidth: 520 }}>
              <Typography id={ids.notify} sx={{ fontWeight: 500, fontSize: 15 }}>
                {telegramSettingsText.notify}
              </Typography>
              <Typography
                id={ids.notifyHint}
                color="text.secondary"
                variant="body2"
                sx={{ mt: 0.25 }}
              >
                {telegramSettingsText.notifyHint}
              </Typography>
            </Box>
            <Switch
              checked={status.data?.notifications ?? true}
              disabled={notify.isPending}
              onChange={(_event, on) => void toggle(on)}
              slotProps={{
                input: { 'aria-labelledby': ids.notify, 'aria-describedby': ids.notifyHint },
              }}
              sx={{ mt: -0.5, mr: -1, flexShrink: 0 }}
            />
          </Stack>
        </>
      ) : (
        <>
          <Alert severity="info" sx={{ mt: 2, maxWidth: 560 }}>
            {telegramSettingsText.abroad}
          </Alert>
          <Stack direction="row" spacing={2} sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" disabled={start.isPending} onClick={() => void startLink()}>
              {link === null ? telegramSettingsText.link : telegramSettingsText.linkAgain}
            </Button>
            {link !== null ? (
              <Link href={link} target="_blank" rel="noopener noreferrer">
                {telegramSettingsText.openLink}
              </Link>
            ) : null}
          </Stack>
          {link !== null ? (
            <Typography color="text.secondary" variant="body2" sx={{ mt: 1.5, maxWidth: 520 }}>
              {telegramSettingsText.opened(LINK_MINUTES)}
            </Typography>
          ) : null}
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
