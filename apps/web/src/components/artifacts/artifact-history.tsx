'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { artifactRoleAtLeast } from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { documentSx, SectionText } from './artifact-document-text'
import { formatDateTime } from './artifact-texts'
import type { CabinetArtifact } from './use-artifact'

// «История версий» (docs/plan/88-artifacts.md, Ар13; board D-history; slice 88.11а; docs/plan/92,
// АТ9): one list of versions — each with who made it and when, its text to read, «Вернуть эту
// версию» (the owner, after a word of whose edits it overwrites) and, of a version after an answer
// of the agent, «Отменить правки агента»; «Сохранить текущую как версию…» with a label. The inner
// journal of changes is not shown to the client.

export const historyTexts = Object.freeze({
  open: 'История версий',
  title: 'История версий',
  close: 'Закрыть историю',
  version: (no: number) => `Версия ${no}`,
  now: 'сейчас',
  byYou: 'Вы',
  bySchedule: 'По расписанию',
  byAgent: (chat: string | null) => (chat ? `Ответ агента · чат «${chat}»` : 'Ответ агента'),
  chat: (title: string) => `агента в чате «${title}»`,
  restore: 'Вернуть эту версию',
  restoreNote: 'Возврат — тоже новая версия: ничего не пропадёт.',
  restoreTitle: (no: number) => `Вернуть версию ${no}?`,
  overwrites: (who: string) => `Будут перезаписаны правки: ${who}.`,
  overwritesNothing: 'Изменятся только ваши правки.',
  blocks: (count: number) => `Изменится разделов: ${count}.`,
  held: 'Сейчас агент пишет в этот артефакт — дождитесь, пока он закончит.',
  agents: (count: number) => (count === 1 ? 'агента' : `агентов (${count})`),
  confirm: 'Вернуть',
  cancel: 'Отмена',
  restored: (no: number) => `Готово: сохранено как версия ${no}.`,
  undoTurn: 'Отменить правки агента',
  undone: (undone: number, kept: number) =>
    kept === 0
      ? `Правки агента отменены: разделов — ${undone}.`
      : `Отменено разделов: ${undone}. ${kept} уже изменили после агента — их мы не трогали.`,
  saveCurrent: 'Сохранить текущую как версию…',
  label: 'Название версии',
  labelHint: 'Например, «Показала маме»',
  save: 'Сохранить',
  saved: (no: number) => `Сохранено как версия ${no}.`,
  failed: 'Не получилось. Попробуйте ещё раз.',
  noVersions: 'Версий пока нет: они появляются после ответов агента и после ваших правок.',
  textGone: 'Текст этой версии не сохранился.',
})

/** «История версий» in the head of an artifact: the button and its panel. */
export function ArtifactHistoryButton({
  artifact,
  onChanged,
}: {
  artifact: CabinetArtifact
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip title={historyTexts.open}>
        <IconButton
          aria-label={historyTexts.open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          sx={{ width: 40, height: 40, flexShrink: 0 }}
        >
          <AppIcon name="history" size={18} />
        </IconButton>
      </Tooltip>
      {open && (
        <ArtifactHistory artifact={artifact} onClose={() => setOpen(false)} onChanged={onChanged} />
      )}
    </>
  )
}

function ArtifactHistory({
  artifact,
  onClose,
  onChanged,
}: {
  artifact: CabinetArtifact
  onClose: () => void
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [chosen, setChosen] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [labelling, setLabelling] = useState(false)
  const [label, setLabel] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const artifactId = artifact.id
  // Read anew each time the history opens: edits since made versions of their own.
  const versions = useQuery({
    ...trpc.artifact.versions.queryOptions({ artifactId }),
    refetchOnMount: 'always',
  })
  const version = useQuery({
    ...trpc.artifact.version.queryOptions({ artifactId, no: chosen ?? 1 }),
    enabled: chosen !== null,
  })
  const preview = useQuery({
    ...trpc.artifact.restorePreview.queryOptions({ artifactId, no: confirming ?? 1 }),
    enabled: confirming !== null,
  })
  const reread = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.artifact.versions.queryKey({ artifactId }),
    })
    onChanged()
  }
  const restore = useMutation(trpc.artifact.restoreVersion.mutationOptions())
  const undoTurn = useMutation(trpc.artifact.undoTurn.mutationOptions())
  const save = useMutation(trpc.artifact.saveVersion.mutationOptions())
  const owner = artifactRoleAtLeast(artifact.role, 'owner')
  const editor = artifactRoleAtLeast(artifact.role, 'edit')
  const rows = versions.data ?? []
  const shown = rows.find((row) => row.no === chosen) ?? null

  const authorOf = (row: (typeof rows)[number]) =>
    row.author === 'user'
      ? historyTexts.byYou
      : row.author === 'schedule'
        ? historyTexts.bySchedule
        : historyTexts.byAgent(row.chat)

  return (
    <Drawer anchor="right" open onClose={onClose}>
      <Box
        role="region"
        aria-label={historyTexts.title}
        sx={{
          width: 'min(100vw, 460px)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, pt: 1.5 }}>
          <Typography component="h2" sx={{ fontSize: 18, fontWeight: 650, flex: 1 }}>
            {historyTexts.title}
          </Typography>
          <IconButton aria-label={historyTexts.close} onClick={onClose}>
            <AppIcon name="close" size={18} />
          </IconButton>
        </Box>
        {notice && (
          <Alert
            severity={notice.ok ? 'success' : 'error'}
            sx={{ mx: 2, mt: 1 }}
            onClose={() => setNotice(null)}
          >
            {notice.text}
          </Alert>
        )}
        <Box sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', px: 2, py: 1.5 }}>
          {versions.isSuccess && rows.length === 0 && (
            <Typography sx={{ color: 'text.secondary' }}>{historyTexts.noVersions}</Typography>
          )}
          <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {rows.map((row) => (
              <li key={row.no}>
                <ButtonBase
                  onClick={() => setChosen(row.no === chosen ? null : row.no)}
                  aria-expanded={row.no === chosen}
                  sx={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    display: 'block',
                    px: 1.25,
                    py: 1,
                    borderRadius: '10px',
                    bgcolor: row.no === chosen ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Typography sx={{ fontWeight: 600, fontSize: 14 }}>
                    {historyTexts.version(row.no)}
                    <Box component="span" sx={{ fontWeight: 400, color: 'text.secondary' }}>
                      {' · '}
                      {row.current ? historyTexts.now : formatDateTime(row.createdAt)}
                    </Box>
                  </Typography>
                  {row.label && <Typography sx={{ fontSize: 14 }}>«{row.label}»</Typography>}
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {authorOf(row)}
                  </Typography>
                </ButtonBase>
                {row.no === chosen && shown !== null && (
                  <Box
                    sx={{
                      mt: 0.5,
                      mb: 1.5,
                      mx: 1.25,
                      pl: 1.5,
                      borderLeft: 2,
                      borderColor: 'divider',
                    }}
                  >
                    {version.data ? (
                      version.data.blocks.length === 0 ? (
                        <Typography sx={{ color: 'text.secondary' }}>
                          {historyTexts.textGone}
                        </Typography>
                      ) : (
                        version.data.blocks.map((block) => (
                          <Box key={block.key} sx={{ mb: 1.5 }}>
                            {block.heading && (
                              <Typography sx={{ fontWeight: 650 }}>{block.heading}</Typography>
                            )}
                            <Box sx={{ ...documentSx, fontSize: 14 }}>
                              <SectionText text={block.content ?? ''} />
                            </Box>
                          </Box>
                        ))
                      )
                    ) : null}
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                      {owner && !shown.current && (
                        <Button
                          variant="contained"
                          size="small"
                          onClick={() => setConfirming(shown.no)}
                        >
                          {historyTexts.restore}
                        </Button>
                      )}
                      {editor &&
                        shown.author === 'turn' &&
                        shown.taskId !== null &&
                        shown.turnNo !== null && (
                          <Button
                            size="small"
                            onClick={() =>
                              void undoTurn
                                .mutateAsync({
                                  artifactId,
                                  taskId: shown.taskId!,
                                  turnNo: shown.turnNo!,
                                })
                                .then((answer) => {
                                  setNotice({
                                    ok: true,
                                    text: historyTexts.undone(answer.undone, answer.kept),
                                  })
                                  reread()
                                })
                                .catch(() => setNotice({ ok: false, text: historyTexts.failed }))
                            }
                          >
                            {historyTexts.undoTurn}
                          </Button>
                        )}
                    </Box>
                    <Typography
                      variant="caption"
                      sx={{ display: 'block', mt: 1, color: 'text.secondary' }}
                    >
                      {historyTexts.restoreNote}
                    </Typography>
                  </Box>
                )}
              </li>
            ))}
          </Box>
        </Box>
        {editor && (
          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            {labelling ? (
              <Box
                component="form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const text = label.trim()
                  if (text === '') return
                  void save
                    .mutateAsync({ artifactId, label: text })
                    .then((answer) => {
                      setLabelling(false)
                      setLabel('')
                      setNotice({ ok: true, text: historyTexts.saved(answer.no) })
                      reread()
                    })
                    .catch(() => setNotice({ ok: false, text: historyTexts.failed }))
                }}
                sx={{ display: 'flex', gap: 1 }}
              >
                <TextField
                  size="small"
                  autoFocus
                  label={historyTexts.label}
                  placeholder={historyTexts.labelHint}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  slotProps={{ htmlInput: { maxLength: 60 } }}
                  sx={{ flex: 1 }}
                />
                <Button
                  type="submit"
                  variant="contained"
                  disabled={label.trim() === '' || save.isPending}
                >
                  {historyTexts.save}
                </Button>
              </Box>
            ) : (
              <Button onClick={() => setLabelling(true)}>{historyTexts.saveCurrent}</Button>
            )}
          </Box>
        )}
      </Box>
      {confirming !== null && (
        <Dialog open onClose={() => setConfirming(null)} aria-labelledby="restore-title">
          <DialogTitle id="restore-title">{historyTexts.restoreTitle(confirming)}</DialogTitle>
          <DialogContent>
            {preview.data ? (
              <>
                <Typography>{historyTexts.blocks(preview.data.blocks)}</Typography>
                <Typography sx={{ mt: 1 }}>
                  {(() => {
                    const who = [
                      ...preview.data.people,
                      ...preview.data.chats.map(historyTexts.chat),
                      ...(preview.data.agents > 0
                        ? [historyTexts.agents(preview.data.agents)]
                        : []),
                    ]
                    return who.length === 0
                      ? historyTexts.overwritesNothing
                      : historyTexts.overwrites(who.join(', '))
                  })()}
                </Typography>
                {preview.data.held > 0 && (
                  <Alert severity="warning" sx={{ mt: 1.5 }}>
                    {historyTexts.held}
                  </Alert>
                )}
                <Typography variant="body2" sx={{ mt: 1.5, color: 'text.secondary' }}>
                  {historyTexts.restoreNote}
                </Typography>
              </>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirming(null)}>{historyTexts.cancel}</Button>
            <Button
              variant="contained"
              disabled={!preview.data || preview.data.held > 0 || restore.isPending}
              onClick={() =>
                void restore
                  .mutateAsync({ artifactId, no: confirming })
                  .then((answer) => {
                    setConfirming(null)
                    setChosen(null)
                    setNotice({ ok: true, text: historyTexts.restored(answer.no) })
                    reread()
                  })
                  .catch(() => {
                    setConfirming(null)
                    setNotice({ ok: false, text: historyTexts.failed })
                  })
              }
            >
              {historyTexts.confirm}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Drawer>
  )
}
