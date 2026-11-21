'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { separatesSectionText } from '@repo/doc-render/markdown'
import {
  artifactCommentRefusalText,
  artifactLimits,
  artifactQuoteAnchorSchema,
  type ArtifactQuoteAnchor,
} from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { artifactAccessLost, artifactErrorData, readPrivateArtifact } from './artifact-access-error'
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

export function ArtifactComments({
  artifact,
  draft,
  onClose,
  onChanged,
  onAccessLost,
}: {
  artifact: CabinetArtifact
  draft: ArtifactQuoteAnchor | null
  onClose: () => void
  onChanged: () => void
  onAccessLost: () => void
}) {
  const trpc = useTRPC()
  const client = useQueryClient()
  const artifactId = artifact.id
  const query = trpc.artifact.comments.queryOptions({ artifactId })
  const list = useQuery({
    queryKey: query.queryKey,
    queryFn: (context) => readPrivateArtifact(() => query.queryFn!(context)),
    gcTime: 0,
    refetchInterval: 20_000,
  })
  const add = useMutation(trpc.artifact.addComment.mutationOptions())
  const resolve = useMutation(trpc.artifact.resolveComment.mutationOptions())
  const [resolved, setResolved] = useState(false)
  const [body, setBody] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState(false)
  const reread = () => client.invalidateQueries({ queryKey: query.queryKey })
  function close() {
    setBody('')
    setAddError(null)
    onClose()
  }

  const denied =
    list.data === null ||
    artifactAccessLost(add.error) ||
    artifactErrorData(resolve.error)?.code === 'UNAUTHORIZED'
  const refreshAccess = useEffectEvent(() => {
    void client.cancelQueries({ queryKey: query.queryKey, exact: true })
    client.setQueryData([...query.queryKey], null)
    add.reset()
    resolve.reset()
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
  return (
    <Box
      component="section"
      aria-label="Заметки к документу"
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
      </Box>
      {list.isError && <Alert severity="error">Не удалось загрузить заметки.</Alert>}
      {resolveError && <Alert severity="error">{failed}</Alert>}
      {list.isSuccess && visible.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {resolved
            ? 'Решённых заметок пока нет.'
            : 'Выделите текст в разделе, чтобы оставить заметку.'}
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
              <Typography
                component="blockquote"
                variant="body2"
                color="text.secondary"
                sx={{ m: 0, pl: 1, borderLeft: 2, borderColor: 'divider' }}
              >
                {comment.anchor.quote}
              </Typography>
              {comment.moved && (
                <Typography variant="caption" color="warning.main">
                  Место изменилось
                </Typography>
              )}
              <Typography variant="body2" sx={{ mt: 0.75, whiteSpace: 'pre-wrap' }}>
                {comment.body}
              </Typography>
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
      <Dialog
        open={list.isSuccess && draft !== null}
        onClose={() => {
          if (!add.isPending) close()
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Заметка к цитате</DialogTitle>
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
              {draft?.quote}
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
