'use client'

import { databaseDumpPathSchema } from '@repo/domain/site-connection/database-dump'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'
import { useMutation } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { formatMoscowMoment } from '@/lib/moscow-date'
import { useTRPC } from '@/trpc/client'

// «Взять базу из файла дампа на хостинге» (owner's decision of 26.10.2026): for a site whose
// database answers only on the hosting, the owner names a SQL dump of the site's file source; a
// preview of a dialog copies its database from it. The page sends the name only — Радити reads
// the file itself through the saved access, when a preview is built.

export const dumpText = Object.freeze({
  title: 'Взять базу из файла дампа на хостинге',
  note: 'Для предпросмотра диалогов мы скачаем этот файл по сохранённому доступу к файлам, загрузим во временную базу и скопируем из неё то же, что из живой базы: без посетителей, заказов и заявок, с вымышленными пользователями. Сам файл никуда больше не отправляется и не хранится.',
  field: 'Путь к файлу от папки, куда попадает вход по FTP или SFTP',
  helper: 'Например backup-2026-08-30.sql или dumps/site.sql.gz',
  save: 'Сохранить',
  change: 'Изменить',
  clear: 'Не брать из дампа',
  cancel: 'Отмена',
  current: 'Файл дампа',
  saved: (at: string) => `сохранено ${at}`,
  invalid: 'Укажите путь к файлу .sql или .sql.gz — без «..» и без «/» в начале.',
  noSource: 'У сайта нет доступа к файлам по SFTP или FTP, поэтому файл дампа взять неоткуда.',
})

export interface DumpView {
  path: string | null
  updatedAt: Date | null
  readable: boolean
}

export function DatabaseDumpForm({ siteId, initial }: { siteId: string; initial: DumpView }) {
  const trpc = useTRPC()
  const save = useMutation(trpc.siteDatabaseDump.set.mutationOptions())
  const [view, setView] = useState(initial)
  const [editing, setEditing] = useState(initial.path === null)
  const [path, setPath] = useState(initial.path ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const fieldId = useId()

  if (!view.readable)
    return (
      <Typography variant="body2" color="text.secondary">
        {dumpText.noSource}
      </Typography>
    )

  const send = async (next: string | null) => {
    setProblem(null)
    try {
      const answer = await save.mutateAsync({ siteId, path: next })
      setView(answer)
      setPath(answer.path ?? '')
      setEditing(answer.path === null)
    } catch (failure) {
      setProblem(callErrorText(failure))
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!databaseDumpPathSchema.safeParse(path).success) {
      setProblem(dumpText.invalid)
      return
    }
    await send(path)
  }

  return (
    <Box
      component="section"
      aria-labelledby={`${fieldId}-title`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, pt: 1 }}
    >
      <Typography id={`${fieldId}-title`} component="h3" sx={{ fontWeight: 600 }}>
        {dumpText.title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 720 }}>
        {dumpText.note}
      </Typography>
      {!editing && view.path ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px' }}>
          <Typography>
            {dumpText.current}:{' '}
            <Box component="span" translate="no" sx={{ fontFamily: fontFamilies.mono }}>
              {view.path}
            </Box>
            {view.updatedAt ? (
              <Typography component="span" variant="body2" color="text.secondary">
                {' · '}
                {dumpText.saved(formatMoscowMoment(view.updatedAt))}
              </Typography>
            ) : null}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="outlined" sx={{ minHeight: 44 }} onClick={() => setEditing(true)}>
              {dumpText.change}
            </Button>
            <Button
              sx={{ minHeight: 44 }}
              disabled={save.isPending}
              onClick={() => void send(null)}
            >
              {dumpText.clear}
            </Button>
          </Box>
        </Box>
      ) : (
        <Box
          component="form"
          noValidate
          onSubmit={(event) => void submit(event)}
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5 }}
        >
          <TextField
            id={fieldId}
            label={dumpText.field}
            helperText={dumpText.helper}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            slotProps={{
              htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
            }}
            sx={{ flex: '1 1 320px', minWidth: 0 }}
          />
          <Box sx={{ display: 'flex', gap: 1, pt: 0.5 }}>
            <Button
              type="submit"
              variant="contained"
              disabled={save.isPending}
              sx={{ minHeight: 44 }}
            >
              {dumpText.save}
            </Button>
            {view.path ? (
              <Button
                sx={{ minHeight: 44 }}
                onClick={() => {
                  setEditing(false)
                  setPath(view.path ?? '')
                  setProblem(null)
                }}
              >
                {dumpText.cancel}
              </Button>
            ) : null}
          </Box>
        </Box>
      )}
      {problem ? (
        <Alert severity="error" role="alert">
          {problem}
        </Alert>
      ) : null}
    </Box>
  )
}
