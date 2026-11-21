'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { separatesSectionText } from '@repo/doc-render/markdown'
import {
  artifactCommentDispatchLimits,
  artifactCommentRefusalText,
  artifactKindSpecOf,
  artifactLimits,
  artifactQuoteAnchorSchema,
  type ArtifactCommentAnchor,
  type ArtifactCommentAnchorInput,
  type ArtifactQuoteAnchor,
} from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'

import { useTRPC, useTRPCClient } from '@/trpc/client'

import { artifactAccessLost, artifactErrorData, readPrivateArtifact } from './artifact-access-error'
import { ArtifactCommentDispatch } from './artifact-comment-dispatch'
import type { CabinetArtifact } from './use-artifact'

function selectionQuote(root: HTMLElement, selected: Selection | null): ArtifactQuoteAnchor | null {
  if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return null
  const range = selected.getRangeAt(0)
  const start = range.startContainer
  const section = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>(
    '[data-quote-block]',
  )
  if (!section || !root.contains(section) || !section.contains(range.endContainer)) return null

  const pieces: string[] = []
  const collect = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) pieces.push(node.textContent ?? '')
    const separates = node instanceof Element && separatesSectionText(node.localName)
    if (separates) pieces.push(' ')
    node.childNodes.forEach(collect)
    if (separates) pieces.push(' ')
  }
  collect(range.cloneContents())
  const anchor = artifactQuoteAnchorSchema.safeParse({
    kind: 'quote',
    block: section.dataset.quoteBlock,
    rev: Number(section.dataset.quoteRev),
    quote: pieces.join(''),
  })
  return anchor.success ? anchor.data : null
}

export function useArtifactQuote(enabled: boolean) {
  const root = useRef<HTMLDivElement>(null)
  const [quote, setQuote] = useState<ArtifactQuoteAnchor | null>(null)
  useEffect(() => {
    if (!enabled) return
    const read = () =>
      setQuote(root.current ? selectionQuote(root.current, document.getSelection()) : null)
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [enabled])
  return { root, quote: enabled ? quote : null }
}

const failed = 'Не удалось сохранить заметку. Попробуйте ещё раз.'

/** The words of the panel by what notes of this kind anchor to (88.18а, 88.18д). */
const noteTexts = {
  quote: {
    dialog: 'Заметка к цитате',
    region: 'Заметки к документу',
    empty: 'Выделите текст в разделе, чтобы оставить заметку.',
  },
  element: {
    dialog: 'Заметка к элементу',
    region: 'Заметки к макету',
    empty: 'Включите «Выбрать элемент», выберите элемент и нажмите «Заметка к элементу».',
  },
  cell: {
    dialog: 'Заметка к ячейке',
    region: 'Заметки к таблице',
    empty: 'Выберите ячейку и нажмите «Заметка к ячейке».',
  },
} as const

/** Where a note stands, as the list shows it. */
function AnchorText({ anchor }: { anchor: ArtifactCommentAnchor }) {
  const sx = { m: 0, pl: 1, borderLeft: 2, borderColor: 'divider' }
  if (anchor.kind === 'cell')
    return (
      <Typography variant="body2" color="text.secondary" sx={sx}>
        {anchor.columnName}: {anchor.text || 'пустая ячейка'}
      </Typography>
    )
  if (anchor.kind === 'element')
    return (
      <Typography variant="body2" color="text.secondary" sx={sx}>
        {anchor.text ? `«${anchor.text}»` : 'Элемент без текста'} · {anchor.tag}
      </Typography>
    )
  return (
    <Typography component="blockquote" variant="body2" color="text.secondary" sx={sx}>
      {anchor.quote}
    </Typography>
  )
}

type ReplyDraft = { threadId: string; body: string }

export function ArtifactComments({
  artifact,
  draft,
  draftLabel,
  onClose,
  onChanged,
  onAccessLost,
}: {
  artifact: CabinetArtifact
  draft: ArtifactCommentAnchorInput | null
  /** How the cabinet names a cell of the draft: «колонка: текст» (the server reads its own). */
  draftLabel?: string
  onClose: () => void
  onChanged: () => void
  onAccessLost: () => void
}) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const client = useQueryClient()
  const artifactId = artifact.id
  const texts = noteTexts[artifactKindSpecOf(artifact.kind)?.notes ?? 'quote']
  const query = trpc.artifact.comments.queryOptions({ artifactId })
  const list = useQuery({
    queryKey: query.queryKey,
    queryFn: (context) => readPrivateArtifact(() => query.queryFn!(context)),
    gcTime: 0,
    refetchInterval: 20_000,
  })
  const add = useMutation(trpc.artifact.addComment.mutationOptions())
  const resolve = useMutation(trpc.artifact.resolveComment.mutationOptions())
  const [reply, setReply] = useState<ReplyDraft | null>(null)
  const [replyPending, setReplyPending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [replyDenied, setReplyDenied] = useState(false)
  const replyAttempts = useRef(new Map<string, string>())
  const activeReply = useRef<AbortController | null>(null)
  const replyTitleId = useId()
  const [resolved, setResolved] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [dispatch, setDispatch] = useState<string[] | null>(null)
  const [body, setBody] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState(false)
  const reread = () => client.invalidateQueries({ queryKey: query.queryKey })
  function close() {
    setBody('')
    setAddError(null)
    onClose()
  }

  function closeReply() {
    activeReply.current?.abort()
    activeReply.current = null
    replyAttempts.current.clear()
    setReply(null)
    setReplyPending(false)
    setReplyError(null)
  }

  const denied =
    list.data === null ||
    artifactAccessLost(add.error) ||
    replyDenied ||
    artifactErrorData(resolve.error)?.code === 'UNAUTHORIZED'
  useLayoutEffect(() => {
    const attempts = replyAttempts.current
    // Stop a late completion before passive effects run on teardown or access loss.
    return () => {
      activeReply.current?.abort()
      activeReply.current = null
      attempts.clear()
    }
  }, [denied])

  const refreshAccess = useEffectEvent(() => {
    void client.cancelQueries({ queryKey: query.queryKey, exact: true })
    client.setQueryData([...query.queryKey], null)
    add.reset()
    resolve.reset()
    closeReply()
    setDispatch(null)
    setSelected([])
    close()
    onAccessLost()
  })
  useEffect(() => {
    // An external access refusal also discards the local draft; hiding the dialog is not enough.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (denied) refreshAccess()
  }, [denied])

  // A section can change without a comment mutation, including when an agent's text passes review.
  const { blocks } = artifact
  useEffect(() => {
    void client.invalidateQueries({ queryKey: trpc.artifact.comments.queryKey({ artifactId }) })
  }, [artifactId, blocks, client, trpc])

  async function save() {
    if (!draft || !body.trim()) return
    setAddError(null)
    try {
      await add.mutateAsync({ artifactId, anchor: draft, body })
      setResolved(false)
      close()
      void reread()
    } catch (error) {
      setAddError(artifactCommentRefusalText(artifactErrorData(error)?.domainCode) ?? failed)
    }
  }

  async function saveReply() {
    if (!reply || denied || activeReply.current) return
    const text = reply.body.trim()
    if (!text) return
    const { threadId } = reply
    // Another failed draft must not replace the key of an earlier unconfirmed save.
    const attemptKey = JSON.stringify([threadId, text])
    const requestId = replyAttempts.current.get(attemptKey) ?? crypto.randomUUID()
    replyAttempts.current.set(attemptKey, requestId)
    const controller = new AbortController()
    activeReply.current = controller
    setReplyPending(true)
    setReplyError(null)
    try {
      // A private draft is never put in the mutation cache or resumed on reconnect.
      await trpcClient.artifact.addCommentReply.mutate(
        { artifactId, threadId, requestId, body: text },
        { signal: controller.signal },
      )
    } catch (error) {
      if (activeReply.current !== controller) return
      activeReply.current = null
      setReplyPending(false)
      if (artifactAccessLost(error)) {
        closeReply()
        setReplyDenied(true)
        return
      }
      const code = artifactErrorData(error)?.domainCode
      setReplyError(
        artifactCommentRefusalText(code) ?? 'Не удалось сохранить ответ. Попробуйте ещё раз.',
      )
      if (code === 'ARTIFACT_COMMENT_UNAVAILABLE') void reread()
      return
    }
    if (activeReply.current !== controller) return
    activeReply.current = null
    closeReply()
    void reread()
  }

  async function toggle(commentId: string, isResolved: boolean) {
    setResolveError(false)
    try {
      await resolve.mutateAsync({ artifactId, commentId, resolved: !isResolved })
      void reread()
    } catch (error) {
      if (artifactErrorData(error)?.domainCode === 'ARTIFACT_NOT_FOUND') {
        // The note may be gone, or the document may no longer be readable. Do not keep the old list.
        void client.resetQueries({ queryKey: query.queryKey, exact: true })
        onChanged()
      } else if (!artifactAccessLost(error)) {
        setResolveError(true)
      }
    }
  }

  if (denied || list.isPending) return null
  const visible = list.data?.filter((comment) => comment.resolved === resolved) ?? []
  const selectedOpen = resolved
    ? []
    : visible.filter(({ id }) => selected.includes(id)).map(({ id }) => id)
  const selectionFull = selectedOpen.length >= artifactCommentDispatchLimits.threads
  return (
    <Box
      component="section"
      aria-label={texts.region}
      sx={{ px: { xs: 1.5, sm: 2 }, py: 1.5, mb: 1 }}
    >
      <Typography component="h2" variant="subtitle1">
        Личные заметки
      </Typography>
      <Box role="group" aria-label="Состояние заметок" sx={{ display: 'flex', gap: 1, my: 0.5 }}>
        <Button
          size="small"
          aria-pressed={!resolved}
          variant={resolved ? 'text' : 'outlined'}
          onClick={() => setResolved(false)}
        >
          Нерешённые
        </Button>
        <Button
          size="small"
          aria-pressed={resolved}
          variant={resolved ? 'outlined' : 'text'}
          onClick={() => setResolved(true)}
        >
          Решённые
        </Button>
        {selectedOpen.length > 0 && (
          <Button size="small" variant="contained" onClick={() => setDispatch(selectedOpen)}>
            Отправить агенту ({selectedOpen.length})
          </Button>
        )}
      </Box>
      {selectionFull && (
        <Typography variant="caption" color="text.secondary">
          За раз можно отправить до {artifactCommentDispatchLimits.threads} заметок.
        </Typography>
      )}
      {list.isError && <Alert severity="error">Не удалось загрузить заметки.</Alert>}
      {resolveError && <Alert severity="error">{failed}</Alert>}
      {list.isSuccess && visible.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {resolved ? 'Решённых заметок пока нет.' : texts.empty}
        </Typography>
      )}
      {visible.length > 0 && (
        <Box component="ul" sx={{ display: 'grid', gap: 1, p: 0, my: 1, listStyle: 'none' }}>
          {visible.map((comment) => (
            <Box
              component="li"
              key={comment.id}
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                p: 1.25,
                overflowWrap: 'anywhere',
              }}
            >
              <AnchorText anchor={comment.anchor} />
              {comment.moved && (
                <Typography variant="caption" color="warning.main">
                  Место изменилось
                </Typography>
              )}
              <Typography variant="body2" sx={{ mt: 0.75, whiteSpace: 'pre-wrap' }}>
                {comment.body}
              </Typography>
              {comment.replies.length > 0 && (
                <Box
                  component="ul"
                  aria-label="Ответы на заметку"
                  sx={{ listStyle: 'none', pl: 1.5, my: 1, borderLeft: 1, borderColor: 'divider' }}
                >
                  {comment.replies.map(({ id, body: text, byAgent }) => (
                    <Typography
                      key={id}
                      component="li"
                      variant="body2"
                      sx={{ py: 0.5, whiteSpace: 'pre-wrap' }}
                    >
                      {byAgent && (
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block' }}
                        >
                          Агент
                        </Typography>
                      )}
                      {text}
                    </Typography>
                  ))}
                </Box>
              )}
              {!comment.resolved && (
                <>
                  <FormControlLabel
                    label="Выбрать для отправки"
                    control={
                      <Checkbox
                        size="small"
                        checked={selectedOpen.includes(comment.id)}
                        disabled={selectionFull && !selectedOpen.includes(comment.id)}
                        onChange={(_, checked) =>
                          setSelected(
                            checked
                              ? [...selectedOpen, comment.id]
                              : selectedOpen.filter((id) => id !== comment.id),
                          )
                        }
                      />
                    }
                  />
                  <Button size="small" onClick={() => setReply({ threadId: comment.id, body: '' })}>
                    Ответить
                  </Button>
                </>
              )}
              <Button
                size="small"
                disabled={resolve.isPending}
                onClick={() => void toggle(comment.id, comment.resolved)}
              >
                {comment.resolved ? 'Открыть заново' : 'Отметить решённой'}
              </Button>
            </Box>
          ))}
        </Box>
      )}
      {dispatch && (
        <ArtifactCommentDispatch
          artifactId={artifactId}
          threadIds={dispatch}
          onClose={() => setDispatch(null)}
          onAccessLost={() => setReplyDenied(true)}
          onSent={() => setSelected([])}
        />
      )}
      {reply && (
        <Dialog open aria-labelledby={replyTitleId} onClose={closeReply} fullWidth maxWidth="sm">
          <DialogTitle id={replyTitleId}>Ответ на заметку</DialogTitle>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault()
              void saveReply()
            }}
          >
            <DialogContent>
              <TextField
                label="Ответ"
                value={reply.body}
                onChange={(event) => setReply({ ...reply, body: event.target.value })}
                autoFocus
                fullWidth
                multiline
                minRows={3}
                disabled={replyPending}
                slotProps={{ htmlInput: { maxLength: artifactLimits.commentChars } }}
              />
              {replyError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {replyError}
                </Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={closeReply}>Отмена</Button>
              <Button
                type="submit"
                variant="contained"
                disabled={replyPending || !reply.body.trim()}
              >
                Сохранить ответ
              </Button>
            </DialogActions>
          </Box>
        </Dialog>
      )}
      <Dialog
        open={list.isSuccess && draft !== null}
        onClose={() => {
          if (!add.isPending) close()
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{texts.dialog}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <DialogContent>
            <Typography
              component="blockquote"
              variant="body2"
              color="text.secondary"
              sx={{ mx: 0, mt: 0, overflowWrap: 'anywhere' }}
            >
              {draft?.kind === 'quote' ? draft.quote : draftLabel}
            </Typography>
            <TextField
              label="Заметка"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              autoFocus
              fullWidth
              multiline
              minRows={3}
              disabled={add.isPending}
              slotProps={{ htmlInput: { maxLength: artifactLimits.commentChars } }}
            />
            {addError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {addError}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={close} disabled={add.isPending}>
              Отмена
            </Button>
            <Button type="submit" variant="contained" disabled={add.isPending || !body.trim()}>
              Сохранить заметку
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  )
}
