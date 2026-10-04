'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'

import { useTRPC } from '@/trpc/client'

import { connectableStacks, stackLabels, type ProjectStack } from './project-labels'

/** The server's text for a refusal with a domain code is Russian already, without a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export function CreateProjectForm({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [stack, setStack] = useState<ProjectStack>('wordpress')
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({})
  const nameInput = useRef<HTMLInputElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const create = useMutation(
    trpc.project.create.mutationOptions({
      onSuccess: (project) => {
        queryClient.setQueryData(trpc.project.list.queryKey(), (previous) => [
          project,
          ...(previous ?? []).filter((item) => item.id !== project.id),
        ])
        void queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
        onCreated(project.name)
      },
    }),
  )

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors: typeof errors = {}
    if (!name.trim()) nextErrors.name = 'Введите название проекта'
    let address = url.trim()
    // Only `scheme://` is a scheme: `example.ru:8443` is a host and a port.
    if (address && !/^[a-z][a-z\d+.-]*:\/\//i.test(address)) address = `https://${address}`
    try {
      const parsed = new URL(address)
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('invalid')
    } catch {
      nextErrors.url = 'Укажите адрес сайта без пути к странице, например https://example.ru'
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      if (nextErrors.name) nameInput.current?.focus()
      else urlInput.current?.focus()
      return
    }
    create.mutate({ name: name.trim(), url: address, stack })
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      aria-labelledby="new-project-title"
      sx={{
        p: { xs: 2, sm: 3.5 },
        my: 4,
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.default',
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 0.75fr) minmax(0, 1.6fr)' },
        columnGap: 5,
        rowGap: 3,
      }}
    >
      <Box>
        <Typography component="h2" id="new-project-title" sx={{ fontSize: 20, fontWeight: 600 }}>
          Новый проект
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.6 }}>
          Укажите основные данные сайта. После добавления он будет ожидать подключения.
        </Typography>
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1.3fr) minmax(0, 1fr)' },
            gap: 2.5,
          }}
        >
          <TextField
            autoFocus
            inputRef={nameInput}
            id="project-name"
            label="Название проекта"
            placeholder="Например, сайт кофейни"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={create.isPending}
            error={Boolean(errors.name)}
            helperText={errors.name}
            required
            fullWidth
            slotProps={{ htmlInput: { maxLength: 255 } }}
            sx={{ gridColumn: '1 / -1' }}
          />
          <TextField
            inputRef={urlInput}
            id="project-url"
            label="Адрес сайта"
            placeholder="https://example.ru"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={create.isPending}
            error={Boolean(errors.url)}
            helperText={errors.url ?? 'Адрес главной страницы, без пути и параметров.'}
            required
            fullWidth
            slotProps={{
              htmlInput: {
                maxLength: 512,
                inputMode: 'url',
                autoCapitalize: 'none',
                spellCheck: false,
              },
            }}
          />
          <TextField
            id="project-platform"
            select
            label="Платформа сайта"
            value={stack}
            onChange={(event) => setStack(event.target.value as ProjectStack)}
            disabled={create.isPending}
            helperText="Сейчас подключаем сайты на WordPress."
            fullWidth
          >
            {(Object.keys(stackLabels) as ProjectStack[]).map((value) =>
              connectableStacks.includes(value) ? (
                <MenuItem key={value} value={value}>
                  {stackLabels[value]}
                </MenuItem>
              ) : (
                <MenuItem key={value} value={value} disabled>
                  {stackLabels[value]} — скоро
                </MenuItem>
              ),
            )}
          </TextField>
        </Box>
        {create.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {create.error.data?.domainCode
              ? sentence(create.error.message)
              : create.error.data?.code === 'BAD_REQUEST'
                ? 'Проверьте название и адрес сайта. Нужен полный адрес без пути к странице.'
                : 'Не удалось добавить проект. Попробуйте ещё раз.'}
          </Alert>
        )}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1,
            mt: 3,
          }}
        >
          <Button type="submit" variant="contained" loading={create.isPending}>
            Создать проект
          </Button>
          <Button color="inherit" onClick={onClose} disabled={create.isPending}>
            Отмена
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
