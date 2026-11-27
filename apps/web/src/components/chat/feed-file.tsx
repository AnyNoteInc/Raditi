'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useMutation } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'
import { fileSizeText } from './chat-format'

/** The words of a file of the agent in the chat. */
export const feedFileText = Object.freeze({
  download: 'Скачать',
  label: (name: string) => `Скачать файл «${name}»`,
  /** A `.skill` the agent packed (docs/plan/97-skills.md, Нв20). */
  saveSkill: 'Сохранить как навык',
  saved: (name: string) => `Навык «${name}» сохранён — он появится в новых чатах.`,
  savedOff: (name: string) =>
    `Навык «${name}» сохранён, но не включён: включено столько навыков, сколько можно.`,
  openSkills: 'Открыть навыки',
  replaceTitle: 'Заменить установленный навык новой версией?',
  replaceBody: (name: string) =>
    `Навык «${name}» уже установлен. Прошлую версию можно будет вернуть в настройках навыков.`,
  replace: 'Заменить',
  keep: 'Не заменять',
  notSkill: 'В этом файле нет навыка, который можно сохранить.',
})

/** A file the agent packed as a skill: «Сохранить как навык» shows on it. */
export const isSkillFile = (name: string): boolean => /\.skill$/iu.test(name)

/** Where the cabinet serves a file of a task: its own origin, for a member of the task. */
export const taskFileHref = (taskId: string, fileId: string): string =>
  `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`

/**
 * A file the agent made for the client in its turn (`feed.file`, docs/plan/66-chat-visuals.md,
 * В8–В10): its name and size, and «Скачать». The browser saves it, never opens it: the route
 * answers it as an attachment. The task is the one of the page (`/chats/{taskId}`).
 */
export function FeedFile({
  fileId,
  name,
  sizeBytes,
}: {
  fileId: string
  name: string
  sizeBytes: number
}) {
  const { taskId } = useParams<{ taskId?: string }>()
  if (typeof taskId !== 'string') return null
  const href = taskFileHref(taskId, fileId)
  return (
    <Box
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1.5,
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '18px',
        bgcolor: 'background.paper',
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
        <AppIcon name="file" size={20} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          sx={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}
        >
          {name}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {fileSizeText(sizeBytes)}
        </Typography>
      </Box>
      <Link
        href={href}
        download={name}
        aria-label={feedFileText.label(name)}
        variant="body2"
        sx={{ flexShrink: 0, fontWeight: 600 }}
      >
        {feedFileText.download}
      </Link>
      {isSkillFile(name) ? <SaveSkill taskId={taskId} fileId={fileId} /> : null}
    </Box>
  )
}

/**
 * «Сохранить как навык» (docs/plan/97-skills.md, Нв20): the click of the client is the
 * confirmation — the words of the model are not. A skill of the same name is replaced only after
 * the client says so.
 */
function SaveSkill({ taskId, fileId }: { taskId: string; fileId: string }) {
  const trpc = useTRPC()
  const install = useMutation(trpc.accountSkills.installFromChatFile.mutationOptions())
  const [saved, setSaved] = useState<{ name: string; enabled: boolean } | null>(null)
  const [existing, setExisting] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const save = async (replace: boolean) => {
    setProblem(null)
    try {
      const answer = await install.mutateAsync({ taskId, fileId, ...(replace ? { replace } : {}) })
      if (answer.status === 'installed') {
        setExisting(null)
        setSaved({ name: answer.name, enabled: answer.enabled })
      } else if (answer.status === 'exists') setExisting(answer.name)
      else setProblem(feedFileText.notSkill)
    } catch (failure) {
      setProblem(callErrorText(failure))
    }
  }

  return (
    <Box sx={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
      {saved === null ? (
        <Box>
          <Button
            size="small"
            variant="outlined"
            loading={install.isPending && existing === null}
            onClick={() => void save(false)}
            sx={{ borderRadius: '999px' }}
          >
            {feedFileText.saveSkill}
          </Button>
        </Box>
      ) : (
        <Alert
          severity={saved.enabled ? 'success' : 'info'}
          role="status"
          action={
            <Button component={NextLink} href="/settings/skills" size="small" color="inherit">
              {feedFileText.openSkills}
            </Button>
          }
        >
          {saved.enabled ? feedFileText.saved(saved.name) : feedFileText.savedOff(saved.name)}
        </Alert>
      )}
      {problem !== null && existing === null ? (
        <Alert severity="error" role="alert">
          {problem}
        </Alert>
      ) : null}
      <ConfirmDialog
        open={existing !== null}
        onClose={() => {
          setExisting(null)
          setProblem(null)
        }}
        title={feedFileText.replaceTitle}
        busy={install.isPending}
        error={existing !== null ? problem : null}
        keepLabel={feedFileText.keep}
        confirmLabel={feedFileText.replace}
        onConfirm={() => void save(true)}
      >
        <Typography sx={{ mt: 1.5 }}>{feedFileText.replaceBody(existing ?? '')}</Typography>
      </ConfirmDialog>
    </Box>
  )
}
