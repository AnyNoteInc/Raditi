'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { callErrorText } from '@/components/chat/call-error'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { SiteCard } from './site-cards'

export const dangerText = Object.freeze({
  title: 'Опасная область',
  deleteTitle: 'Удалить проект',
  deleteNote:
    'Проект пропадёт из кабинета, а доступы к сайту и значения переменных будут стёрты из хранилища. Сам сайт и его файлы на хостинге не изменятся. Адрес сайта можно будет добавить заново.',
  delete: 'Удалить проект',
  confirmTitle: (name: string) => `Удалить проект «${name}»?`,
  confirmBody:
    'Вернуть проект не получится: диалоги, версии и доступы пропадут из кабинета. Пока на сайте идёт работа — диалог, выпуск или настройка, — удалить проект нельзя.',
  nameLabel: 'Название проекта',
  nameHelp: (name: string) => `Чтобы подтвердить, введите «${name}».`,
  nameMismatch: 'Название не совпадает. Введите название проекта точно так, как оно написано.',
  keep: 'Не удалять',
})

/**
 * «Опасная область» of the settings of a site: «Удалить проект» (owner's decision of
 * 25.10.2026). The name of the site is typed again before `project.delete`; the server checks it
 * and the rights once more. After the deletion the cabinet goes to the list of projects.
 * `untitled` — inside the block of «Настройки» that names it: the card has no heading of its own.
 */
export function SiteDangerZone({
  site,
  untitled = false,
}: {
  site: { id: string; name: string }
  untitled?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const remove = useMutation(trpc.project.delete.mutationOptions())
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (typed.trim() !== site.name.trim()) {
      setError(dangerText.nameMismatch)
      return
    }
    setError(null)
    try {
      await remove.mutateAsync({ id: site.id, confirmName: typed })
      void queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
      router.replace('/projects')
      router.refresh()
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  return (
    <SiteCard {...(untitled ? {} : { title: dangerText.title })}>
      <Box
        sx={{
          px: { xs: 2, sm: 2.75 },
          py: 2.25,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
        }}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 320px' }}>
          <Typography sx={{ fontWeight: 600 }}>{dangerText.deleteTitle}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 720 }}>
            {nbsp(dangerText.deleteNote)}
          </Typography>
        </Box>
        <Button
          variant="outlined"
          color="error"
          sx={{ minHeight: 44 }}
          onClick={() => {
            setTyped('')
            setError(null)
            setOpen(true)
          }}
        >
          {dangerText.delete}
        </Button>
      </Box>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={dangerText.confirmTitle(site.name)}
        busy={remove.isPending}
        error={error}
        keepLabel={dangerText.keep}
        confirmLabel={dangerText.delete}
        danger
        onConfirm={() => void confirm()}
      >
        <Typography sx={{ mt: 1.5 }}>{nbsp(dangerText.confirmBody)}</Typography>
        <TextField
          label={dangerText.nameLabel}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={remove.isPending}
          helperText={dangerText.nameHelp(site.name)}
          fullWidth
          autoFocus
          sx={{ mt: 2 }}
          slotProps={{ htmlInput: { autoComplete: 'off', spellCheck: false } }}
        />
      </ConfirmDialog>
    </SiteCard>
  )
}
