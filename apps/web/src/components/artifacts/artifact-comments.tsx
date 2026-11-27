'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
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
  artifactRoleAtLeast,
  type ArtifactCommentAnchor,
  type ArtifactCommentAnchorInput,
  type ArtifactQuoteAnchor,
} from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { DictationButton, withDictatedWords } from '@/components/chat/dictation-button'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import {
  artifactAccessLost,
  artifactErrorData,
  privateArtifactQuery,
} from './artifact-access-error'
import { ArtifactCommentDispatch } from './artifact-comment-dispatch'
import { ArtifactQuickEdit, useQuickEdits } from './artifact-quick-edit'
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

/**
 * Threads other people see (docs/plan/88-artifacts.md, Э10а, 88.17а) are open here: the page says
 * so from the flag of production; a tab beside a chat leaves the owner private notes only.
 */
export const ArtifactSharingAvailable = createContext(false)

/** Whether a reader may write a note or a comment: the owner always, «Комментирует» in threads of all. */
export function artifactNotesWritable(role: CabinetArtifact['role'], sharing: boolean): boolean {
  return role === 'owner' || (sharing && (role === 'comment' || role === 'edit'))
}

/**
 * The panel of notes on the page of an artifact (docs/plan/93-artifacts-trim.md, АТ9): hidden
 * until «Заметки · N» of the head opens it. Without it — a tab beside a chat, a screen opened in
 * full — the panel shows itself whenever there are notes; with none it is never there.
 */
export const ArtifactNotesPanel = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
} | null>(null)

/** Whether a reader has notes of an artifact at all: the owner's, and threads of all where open. */
export function artifactNotesShown(artifact: CabinetArtifact, sharing: boolean): boolean {
  return (
    (artifact.role === 'owner' || sharing) && artifactKindSpecOf(artifact.kind)?.notes !== undefined
  )
}

/** The notes of an artifact as its head counts them: all of them, and those still open. */
export function useArtifactNotesCount(artifactId: string, enabled: boolean) {
  const trpc = useTRPC()
  const list = useQuery({
    ...privateArtifactQuery(trpc.artifact.comments.queryOptions({ artifactId })),
    enabled,
    refetchInterval: 20_000,
  })
  const rows = (enabled ? list.data : null) ?? []
  return { total: rows.length, open: rows.filter((row) => !row.resolved).length }
}

/** The words of the panel by what notes of this kind anchor to (88.18а, 88.18д). */
const noteTexts = {
  quote: {
    dialog: 'Заметка к цитате',
    region: 'Заметки к документу',
    empty: 'Выделите текст в разделе, чтобы оставить заметку.',
  },
  element: {
    dialog: 'Заметка к элементу',
    region: 'Заметки к экранам',
    empty:
      'В меню «⋯» выберите «Выбрать элемент для заметки», нажмите на часть экрана и затем «Заметка к элементу».',
  },
} as const

/** Where a note stands, as the list shows it. */
function AnchorText({ anchor }: { anchor: ArtifactCommentAnchor }) {
  const sx = { m: 0, pl: 1, borderLeft: 2, borderColor: 'divider' }
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

/** Dictated words after the written ones, within the length of a note (Ар53: диктовка). */
const dictated = (written: string, words: string) =>
  Array.from(withDictatedWords(written, words)).slice(0, artifactLimits.commentChars).join('')

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
  /** How the cabinet names the element of the draft: «тег — текст» (the server reads its own). */
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
  const sharing = useContext(ArtifactSharingAvailable)
  const panel = useContext(ArtifactNotesPanel)
  const owner = artifact.role === 'owner'
  const writable = artifactNotesWritable(artifact.role, sharing)
  const quickEdits = artifact.kind === 'document' && artifactRoleAtLeast(artifact.role, 'edit')
  // The edits live with the panel: a note an edit closed leaves the list, «Отменить» stays.
  const quick = useQuickEdits({
    artifactId,
    onDone: () => {
      void client.invalidateQueries({ queryKey: trpc.artifact.comments.queryKey({ artifactId }) })
      onChanged()
    },
  })
  // The owner chooses; another reader writes only into threads of all (88.17а).
  const [forAll, setForAll] = useState(!owner)
  const query = trpc.artifact.comments.queryOptions({ artifactId })
  const list = useQuery({
    ...privateArtifactQuery(query),
    refetchInterval: 20_000,
  })
  const add = useMutation(trpc.artifact.addComment.mutationOptions())
  const resolve = useMutation(trpc.artifact.resolveComment.mutationOptions())
  const [reply, setReply] = useState<ReplyDraft | null>(null)
  const [replyPending, setReplyPending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const replyAttempts = useRef(new Map<string, string>())
  const activeReply = useRef<AbortController | null>(null)
  const replyTitleId = useId()
  const [resolved, setResolved] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [dispatch, setDispatch] = useState<string[] | null>(null)
  const [dispatchStale, setDispatchStale] = useState(false)
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
    accessDenied ||
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
      await add.mutateAsync({
        artifactId,
        anchor: draft,
        body,
        ...(forAll && sharing ? { shared: true } : {}),
      })
      setResolved(false)
      close()
      // The note just made is shown with the others.
      panel?.setOpen(true)
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
        setAccessDenied(true)
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
  // No notes — no panel (АТ9); on the page, only while «Заметки · N» keeps it open.
  const shown = (list.data?.length ?? 0) > 0 && (panel === null || panel.open)
  return (
    <>
      {shown && (
        <Box
          component="section"
          aria-label={texts.region}
          sx={{
            px: { xs: 1.5, sm: 2 },
            py: 1.5,
            mb: 2,
            borderRadius: '14px',
            bgcolor: 'action.hover',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography component="h2" variant="subtitle1" sx={{ flex: 1 }}>
              {sharing ? 'Заметки и комментарии' : 'Личные заметки'}
            </Typography>
            {panel !== null && (
              <Tooltip title="Скрыть заметки">
                <IconButton
                  size="small"
                  aria-label="Скрыть заметки"
                  onClick={() => panel.setOpen(false)}
                >
                  <AppIcon name="close" size={16} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
          <Box
            role="group"
            aria-label="Состояние заметок"
            sx={{ display: 'flex', gap: 1, my: 0.5 }}
          >
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
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  setDispatchStale(false)
                  setDispatch(selectedOpen)
                }}
              >
                Отправить агенту ({selectedOpen.length})
              </Button>
            )}
          </Box>
          {selectionFull && (
            <Typography variant="caption" color="text.secondary">
              За раз можно отправить до {artifactCommentDispatchLimits.threads} заметок.
            </Typography>
          )}
          {quick.notices}
          {list.isError && <Alert severity="error">Не удалось загрузить заметки.</Alert>}
          {resolveError && <Alert severity="error">{failed}</Alert>}
          {dispatchStale && (
            <Alert severity="warning" onClose={() => setDispatchStale(false)}>
              Одна из выбранных заметок решена или больше недоступна. Проверьте выбор и отправьте
              заметки заново.
            </Alert>
          )}
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
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {comment.shared
                      ? `${comment.author.own ? 'Вы' : comment.author.name || 'Пользователь'} · для всех`
                      : 'Личная заметка'}
                  </Typography>
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
                      sx={{
                        listStyle: 'none',
                        pl: 1.5,
                        my: 1,
                        borderLeft: 1,
                        borderColor: 'divider',
                      }}
                    >
                      {comment.replies.map(({ id, body: text, byAgent, authorName, own }) => (
                        <Typography
                          key={id}
                          component="li"
                          variant="body2"
                          sx={{ py: 0.5, whiteSpace: 'pre-wrap' }}
                        >
                          {(byAgent || comment.shared) && (
                            <Typography
                              component="span"
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: 'block' }}
                            >
                              {byAgent ? 'Агент' : own ? 'Вы' : authorName || 'Пользователь'}
                            </Typography>
                          )}
                          {text}
                        </Typography>
                      ))}
                    </Box>
                  )}
                  {!comment.resolved && (
                    <>
                      {/* Own private notes, and threads of all for «Комментирует» (88.17а). */}
                      {(comment.shared ? writable : owner && comment.author.own) && (
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
                      )}
                      {(comment.shared ? writable : owner) && (
                        <Button
                          size="small"
                          onClick={() => setReply({ threadId: comment.id, body: '' })}
                        >
                          Ответить
                        </Button>
                      )}
                      {/* A quick edit of the agent (docs/plan/98-quick-edits.md): «Правит» and up. */}
                      {quickEdits &&
                        comment.anchor.kind === 'quote' &&
                        (comment.author.own || comment.shared) && (
                          <ArtifactQuickEdit
                            quick={quick}
                            threadId={comment.id}
                            own={comment.author.own}
                            authorName={comment.author.name}
                            moved={comment.moved}
                          />
                        )}
                    </>
                  )}
                  {(owner || (comment.shared && writable && comment.author.own)) && (
                    <Button
                      size="small"
                      disabled={resolve.isPending}
                      onClick={() => void toggle(comment.id, comment.resolved)}
                    >
                      {comment.resolved ? 'Открыть заново' : 'Отметить решённой'}
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
      {dispatch && (
        <ArtifactCommentDispatch
          artifactId={artifactId}
          threadIds={dispatch}
          onClose={() => setDispatch(null)}
          onAccessLost={() => setAccessDenied(true)}
          onSelectionStale={() => {
            // The list read again drops what is no longer open from the selection.
            setDispatch(null)
            setDispatchStale(true)
            void reread()
          }}
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
              <DictationButton
                disabled={replyPending}
                onWords={(words) =>
                  setReply(
                    (current) => current && { ...current, body: dictated(current.body, words) },
                  )
                }
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
            <DictationButton
              disabled={add.isPending}
              onWords={(words) => setBody((written) => dictated(written, words))}
            />
            {owner && sharing && (
              <FormControlLabel
                label="Видят все, у кого есть доступ"
                control={
                  <Checkbox
                    checked={forAll}
                    onChange={(event) => setForAll(event.target.checked)}
                    disabled={add.isPending}
                  />
                }
              />
            )}
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
    </>
  )
}
