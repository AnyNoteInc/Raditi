'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'
import { canonicalSection } from '@repo/doc-bridge'
import { ArtifactSectionMarkdown } from '@repo/doc-render/markdown'
import {
  artifactKindSpecOf,
  artifactRoleAtLeast,
  type ArtifactQuoteAnchor,
} from '@repo/domain/artifacts'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { ArtifactComments, useArtifactQuote } from './artifact-comments'
import { documentTexts, editorTexts } from './artifact-texts'
import { SectionEditor, type SectionEditorHandle } from './editor/section-editor'
import { mergeThree, wordDiff, type DiffPiece } from './merge'
import type { ArtifactPresence, CabinetArtifact } from './use-artifact'

// A document of the artifacts (docs/plan/88-artifacts.md, Ар17, Ар18, §7.7; boards C-doc,
// D-together, D-conflict): its sections as they read, and a section in its editor. A section
// opened for editing is held for the person while they type (`artifact.hold`, 30 s, renewed); one
// an agent writes is not — the person waits, or takes it back («Забрать правку»). A save names the
// revision it was made from: when the section changed meanwhile, the two texts merge by lines, and
// where they touch the same lines «Разошлись» shows both and the person chooses.

type Block = CabinetArtifact['blocks'][number]

/** How the text of a document is dressed: the colours of the cabinet, in the light and the dark. */
export const documentSx = {
  fontSize: 16,
  lineHeight: 1.7,
  overflowWrap: 'anywhere',
  '& h3': { fontSize: 18, fontWeight: 600, mt: 2.5, mb: 1 },
  '& h4, & h5, & h6': { fontSize: 16, fontWeight: 600, mt: 2, mb: 1 },
  '& p, & ul, & ol, & pre, & blockquote, & table': { my: 1.25 },
  '& ul, & ol': { pl: 3 },
  '& a': { color: 'primary.main' },
  '& code': { px: 0.5, borderRadius: '6px', bgcolor: 'action.hover', fontSize: '0.9em' },
  '& pre': { p: 1.5, borderRadius: '12px', overflowX: 'auto', bgcolor: 'action.hover' },
  '& pre code': { p: 0, bgcolor: 'transparent' },
  '& blockquote': { mx: 0, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
  '& table': { display: 'block', overflowX: 'auto', borderCollapse: 'collapse', fontSize: 14 },
  '& th, & td': { border: 1, borderColor: 'divider', px: 1.25, py: 0.75, textAlign: 'left' },
  '& img': { maxWidth: '100%', height: 'auto', borderRadius: '8px' },
} as const

export function SectionText({ text }: { text: string }) {
  return <ArtifactSectionMarkdown text={text} />
}

/** An id of a new section by the rule of `section_key` (§7.2). */
const newKey = () => `s${Math.random().toString(36).slice(2, 12)}`
const newOpId = () => `cab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

interface WriteError {
  data?: { domainCode?: string | null; artifact?: { rev?: number; content?: string | null } }
  message?: string
}

const codeOf = (error: unknown) => (error as WriteError | null)?.data?.domainCode ?? null

/** The agents that hold a block now, as presence names them (Ар21: another's chat — «Агент <Имя>»). */
function agentOf(presence: ArtifactPresence | null, block: string) {
  for (const agent of presence?.agents ?? []) {
    const held = agent.blocks.find((each) => each.key === block)
    if (held) return { label: agent.label, intent: held.intent }
  }
  return null
}

function Pieces({ pieces }: { pieces: readonly DiffPiece[] }) {
  return (
    <Typography component="div" sx={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>
      {pieces.map((piece, index) =>
        piece.kind === 'same' ? (
          <span key={index}>{piece.text}</span>
        ) : (
          <Box
            key={index}
            component={piece.kind === 'removed' ? 'del' : 'ins'}
            sx={{
              bgcolor: piece.kind === 'removed' ? 'error.light' : 'success.light',
              color: 'text.primary',
              textDecoration: piece.kind === 'removed' ? 'line-through' : 'none',
              borderRadius: '4px',
              px: 0.25,
            }}
          >
            <Box component="span" sx={visuallyHidden}>
              {piece.kind === 'removed' ? documentTexts.removed : documentTexts.added}
            </Box>
            {piece.text}
          </Box>
        ),
      )}
    </Typography>
  )
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

/** «Разошлись» (D-conflict, on the right): both texts, and what the person keeps. */
function DivergedDialog({
  base,
  mine,
  theirs,
  onKeepMine,
  onTakeOther,
  onByHand,
}: {
  base: string
  mine: string
  theirs: string
  onKeepMine: () => void
  onTakeOther: () => void
  onByHand: () => void
}) {
  return (
    <Dialog open onClose={onTakeOther} maxWidth="md" fullWidth aria-labelledby="diverged-title">
      <DialogTitle id="diverged-title">{documentTexts.divergedTitle}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontWeight: 600 }}>{documentTexts.divergedLead}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          {documentTexts.divergedText}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <Box component="section" aria-label={documentTexts.yourText}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {documentTexts.yourText}
            </Typography>
            <Pieces pieces={wordDiff(base, mine)} />
          </Box>
          <Box component="section" aria-label={documentTexts.otherText}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {documentTexts.otherText}
            </Typography>
            <Pieces pieces={wordDiff(base, theirs)} />
          </Box>
        </Box>
        <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'text.secondary' }}>
          {documentTexts.bothKept}
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onByHand}>{documentTexts.mergeByHand}</Button>
        <Button onClick={onTakeOther}>{documentTexts.takeOther}</Button>
        <Button variant="contained" onClick={onKeepMine}>
          {documentTexts.keepMine}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

type Outcome = 'saved' | 'diverged' | 'waiting' | 'failed'

/**
 * A section in its editor: held for the person, saved a moment after they stop typing and on
 * «Готово», merged three ways when it changed meanwhile.
 */
function SectionEditing({
  artifactId,
  block,
  agent,
  onClose,
  onSaved,
}: {
  artifactId: string
  block: Block
  agent: { label: string } | null
  onClose: () => void
  onSaved: () => void
}) {
  const trpc = useTRPC()
  const hold = useMutation(trpc.artifact.hold.mutationOptions())
  const release = useMutation(trpc.artifact.release.mutationOptions())
  const take = useMutation(trpc.artifact.take.mutationOptions())
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const editor = useRef<SectionEditorHandle>(null)
  const base = useRef({
    content: canonicalSection(block.content ?? ''),
    heading: block.heading ?? '',
    rev: block.rev,
  })
  const [heading, setHeading] = useState(base.current.heading)
  const [mode, setMode] = useState<'holding' | 'editing' | 'waiting'>('holding')
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'failed'>('saved')
  const [diverged, setDiverged] = useState<{ mine: string; theirs: string; rev: number } | null>(
    null,
  )
  const [byHand, setByHand] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const holdNow = async () => {
    try {
      await hold.mutateAsync({ artifactId, block: block.key })
      setMode('editing')
      return true
    } catch (error) {
      if (codeOf(error) === 'ARTIFACT_BLOCK_HELD') setMode('waiting')
      return false
    }
  }

  // The section is asked for once it opens, again every 10 s while it is typed in (the lease is
  // 30 s) and every 5 s while an agent holds it; it is let go as the editor closes.
  const ask = useEffectEvent(() => void holdNow())
  const letGo = useEffectEvent(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    release.mutate({ artifactId, block: block.key })
  })
  useEffect(() => {
    const first = window.setTimeout(() => ask(), 0)
    return () => {
      window.clearTimeout(first)
      letGo()
    }
  }, [artifactId, block.key])
  useEffect(() => {
    if (mode === 'holding') return
    const renew = window.setInterval(() => ask(), mode === 'editing' ? 10_000 : 5_000)
    return () => window.clearInterval(renew)
  }, [mode])

  async function send(content: string, title: string, ifRev: number): Promise<Outcome> {
    setStatus('saving')
    try {
      const answer = await write.mutateAsync({
        batch: {
          artifactId,
          opId: newOpId(),
          ops: [
            {
              op: 'replace',
              block: block.key,
              ifRev,
              content,
              props: { heading: title || documentTexts.untitled },
            },
          ],
        },
      })
      const rev = answer.blocks.find((each) => each.key === block.key)?.rev ?? ifRev
      base.current = { content: canonicalSection(content), heading: title, rev }
      setStatus('saved')
      onSaved()
      return 'saved'
    } catch (error) {
      const code = codeOf(error)
      if (code === 'ARTIFACT_STALE') {
        const current = (error as WriteError).data?.artifact
        const theirs = canonicalSection(current?.content ?? '')
        const rev = current?.rev ?? ifRev
        const merged = mergeThree(base.current.content, canonicalSection(content), theirs)
        if (merged.clean) {
          editor.current?.load(merged.text)
          return send(merged.text, title, rev)
        }
        setDiverged({ mine: canonicalSection(content), theirs, rev })
        setStatus('dirty')
        return 'diverged'
      }
      if (code === 'ARTIFACT_BLOCK_HELD' || code === 'ARTIFACT_LEASE_LOST') {
        setMode('waiting')
        setStatus('dirty')
        return 'waiting'
      }
      setStatus('failed')
      return 'failed'
    }
  }

  async function save(): Promise<Outcome> {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const value = editor.current?.value()
    if (!value) return 'failed'
    if (value.content === base.current.content && value.heading === base.current.heading) {
      setStatus('saved')
      return 'saved'
    }
    return send(value.content, value.heading, base.current.rev)
  }

  function changed() {
    setStatus('dirty')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), 1500)
  }

  const statusText =
    status === 'saving'
      ? documentTexts.saving
      : status === 'failed'
        ? documentTexts.failed
        : status === 'dirty'
          ? documentTexts.unsaved
          : documentTexts.saved

  return (
    <Box
      sx={{
        position: 'relative',
        p: { xs: 1.5, sm: 2 },
        borderRadius: '14px',
        border: 2,
        borderColor: mode === 'waiting' ? 'warning.main' : 'primary.main',
        bgcolor: 'background.paper',
      }}
    >
      {mode === 'waiting' && (
        <Alert
          severity="warning"
          icon={<AppIcon name="pencil" size={18} />}
          sx={{ mb: 1.5 }}
          action={
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button size="small" color="inherit" onClick={() => void holdNow()}>
                {documentTexts.wait}
              </Button>
              <Button
                size="small"
                variant="contained"
                color="warning"
                onClick={() =>
                  void take
                    .mutateAsync({ artifactId, block: block.key })
                    .then((taken) => {
                      base.current = { ...base.current, rev: taken.rev }
                      setMode('editing')
                      onSaved()
                    })
                    .catch(() => undefined)
                }
              >
                {documentTexts.takeBack}
              </Button>
            </Box>
          }
        >
          <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{documentTexts.waitTitle}</Typography>
          <Typography variant="body2">{documentTexts.waitText(agent?.label ?? null)}</Typography>
        </Alert>
      )}
      {mode !== 'holding' && (
        <SectionEditor
          ref={editor}
          heading={heading}
          content={base.current.content}
          label={editorTexts.label(heading || documentTexts.untitled)}
          editable={mode === 'editing'}
          onHeading={setHeading}
          onChange={changed}
        />
      )}
      {byHand !== null && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {documentTexts.byHandNote}
          </Typography>
          <Box sx={documentSx}>
            <SectionText text={byHand} />
          </Box>
        </Alert>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1.25 }}>
        <Typography
          variant="caption"
          role="status"
          sx={{ color: status === 'failed' ? 'error.main' : 'text.secondary' }}
        >
          {statusText}
        </Typography>
        <Button
          size="small"
          variant="contained"
          sx={{ ml: 'auto' }}
          disabled={mode !== 'editing' || status === 'saving'}
          onClick={() =>
            void save().then((outcome) => {
              if (outcome === 'saved') onClose()
            })
          }
        >
          {documentTexts.done}
        </Button>
      </Box>
      {diverged !== null && (
        <DivergedDialog
          base={base.current.content}
          mine={diverged.mine}
          theirs={diverged.theirs}
          onKeepMine={() => {
            const { mine, rev } = diverged
            setDiverged(null)
            void send(mine, editor.current?.value().heading ?? heading, rev)
          }}
          onTakeOther={() => {
            const { theirs, rev } = diverged
            setDiverged(null)
            base.current = { ...base.current, content: theirs, rev }
            editor.current?.load(theirs)
            setStatus('saved')
          }}
          onByHand={() => {
            const { mine, theirs, rev } = diverged
            setDiverged(null)
            base.current = { ...base.current, content: theirs, rev }
            editor.current?.load(theirs)
            setByHand(mine)
            setStatus('dirty')
          }}
        />
      )}
    </Box>
  )
}

/**
 * The sections of a document: «Править» opens one in its editor; the menu of a section adds,
 * moves and removes. `compact` — the tab beside the chat: no outline, a narrower column.
 */
export function ArtifactDocument({
  artifact,
  presence,
  onChanged,
  onAccessLost,
  onEditing,
  header,
}: {
  artifact: CabinetArtifact
  presence: ArtifactPresence | null
  onChanged: () => void
  onAccessLost: () => void
  /** The block the person is in, for their mark of presence. */
  onEditing?: (block: string | null) => void
  header?: ReactNode
}) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; block: Block } | null>(null)
  const [failed, setFailed] = useState(false)
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const canComment =
    artifact.role === 'owner' && artifactKindSpecOf(artifact.kind)?.notes === 'quote'
  const { root: quoteRoot, quote } = useArtifactQuote(canComment)
  const [commentDraft, setCommentDraft] = useState<ArtifactQuoteAnchor | null>(null)
  const sections = artifact.blocks.filter((block) => block.kind === 'section')
  const editingBlock = sections.find((block) => block.key === editing) ?? null

  useEffect(() => onEditing?.(editing), [editing, onEditing])

  async function batch(ops: unknown[]) {
    setFailed(false)
    try {
      const answer = await write.mutateAsync({
        batch: { artifactId: artifact.id, opId: newOpId(), ops },
      })
      onChanged()
      return answer
    } catch {
      setFailed(true)
      onChanged()
      return null
    }
  }

  async function addSection() {
    const key = newKey()
    const last = sections.at(-1)?.key ?? null
    const answer = await batch([
      {
        op: 'insert',
        block: key,
        after: last,
        kind: 'section',
        content: '',
        props: { heading: documentTexts.newHeading },
      },
    ])
    if (answer) setEditing(key)
  }

  return (
    <Box ref={quoteRoot}>
      {header}
      {canComment && (
        <ArtifactComments
          key={artifact.id}
          artifact={artifact}
          draft={commentDraft}
          onClose={() => setCommentDraft(null)}
          onChanged={onChanged}
          onAccessLost={onAccessLost}
        />
      )}
      {failed && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setFailed(false)}>
          {documentTexts.failed}
        </Alert>
      )}
      {sections.length === 0 && (
        <Typography sx={{ color: 'text.secondary', py: 3 }}>{documentTexts.empty}</Typography>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {sections.map((block) => {
          const agent = agentOf(presence, block.key)
          const person = presence?.people.find((each) => !each.self && each.block === block.key)
          const agentHolds = block.hold === 'checking' || block.hold === 'claim'
          const canAnchor = canComment && !block.checking
          if (editingBlock?.key === block.key)
            return (
              <SectionEditing
                key={block.key}
                artifactId={artifact.id}
                block={block}
                agent={agent}
                onClose={() => setEditing(null)}
                onSaved={onChanged}
              />
            )
          return (
            <Box
              component="section"
              key={block.key}
              id={`section-${block.key}`}
              aria-labelledby={`section-${block.key}-title`}
              sx={{
                position: 'relative',
                px: { xs: 1.5, sm: 2 },
                py: 1.5,
                borderRadius: '14px',
                border: 1,
                borderColor: agentHolds ? 'warning.main' : person ? 'info.main' : 'transparent',
                '&:hover': { borderColor: agentHolds ? 'warning.main' : 'divider' },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography
                  id={`section-${block.key}-title`}
                  component="h2"
                  sx={{ fontSize: 21, fontWeight: 650, lineHeight: 1.3, flex: '1 1 auto' }}
                >
                  {block.heading ?? documentTexts.untitled}
                </Typography>
                {agentHolds && (
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={
                      agent
                        ? documentTexts.agentWritingNamed(agent.label)
                        : documentTexts.agentWriting
                    }
                  />
                )}
                {person && (
                  <Chip
                    size="small"
                    color="info"
                    variant="outlined"
                    label={documentTexts.humanEditing(person.name)}
                  />
                )}
                {canEdit && (
                  <>
                    <Button
                      size="small"
                      onClick={() => setEditing(block.key)}
                      aria-label={documentTexts.editLabel(block.heading ?? documentTexts.untitled)}
                      startIcon={<AppIcon name="pencil" size={14} />}
                    >
                      {documentTexts.edit}
                    </Button>
                    <IconButton
                      size="small"
                      aria-haspopup="menu"
                      aria-label={documentTexts.sectionActions(
                        block.heading ?? documentTexts.untitled,
                      )}
                      onClick={(event) => setMenu({ anchor: event.currentTarget, block })}
                    >
                      <AppIcon name="more" size={18} />
                    </IconButton>
                  </>
                )}
              </Box>
              {block.content === null ? (
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
                  {documentTexts.checking}
                </Typography>
              ) : (
                <Box
                  sx={documentSx}
                  data-quote-block={canAnchor ? block.key : undefined}
                  data-quote-rev={canAnchor ? block.rev : undefined}
                >
                  <SectionText text={block.content} />
                </Box>
              )}
              {canAnchor && quote && quote.block === block.key && quote.rev === block.rev && (
                <Button
                  size="small"
                  variant="outlined"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setCommentDraft(quote)}
                >
                  Добавить заметку к цитате
                </Button>
              )}
              {agent?.intent && (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {agent.intent}
                </Typography>
              )}
            </Box>
          )
        })}
      </Box>
      {canEdit && (
        <Button
          sx={{ mt: 2.5 }}
          startIcon={<AppIcon name="plus" size={16} />}
          onClick={() => void addSection()}
          disabled={write.isPending}
        >
          {documentTexts.addSection}
        </Button>
      )}
      <Menu anchorEl={menu?.anchor ?? null} open={menu !== null} onClose={() => setMenu(null)}>
        {menu !== null &&
          (() => {
            const at = sections.findIndex((each) => each.key === menu.block.key)
            const items: ReactNode[] = []
            if (at > 0)
              items.push(
                <MenuItem
                  key="up"
                  onClick={() => {
                    setMenu(null)
                    void batch([
                      {
                        op: 'move',
                        block: menu.block.key,
                        ifRev: menu.block.rev,
                        after: at > 1 ? sections[at - 2]!.key : null,
                      },
                    ])
                  }}
                >
                  {documentTexts.moveUp}
                </MenuItem>,
              )
            if (at < sections.length - 1)
              items.push(
                <MenuItem
                  key="down"
                  onClick={() => {
                    setMenu(null)
                    void batch([
                      {
                        op: 'move',
                        block: menu.block.key,
                        ifRev: menu.block.rev,
                        after: sections[at + 1]!.key,
                      },
                    ])
                  }}
                >
                  {documentTexts.moveDown}
                </MenuItem>,
              )
            items.push(
              <MenuItem
                key="remove"
                onClick={() => {
                  setMenu(null)
                  void batch([{ op: 'delete', block: menu.block.key, ifRev: menu.block.rev }])
                }}
              >
                {documentTexts.remove}
              </MenuItem>,
            )
            return items
          })()}
      </Menu>
    </Box>
  )
}
