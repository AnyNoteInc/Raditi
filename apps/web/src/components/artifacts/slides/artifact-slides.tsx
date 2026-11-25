'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Collapse from '@mui/material/Collapse'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import {
  artifactRoleAtLeast,
  artifactSlidesOf,
  newSlideHtml,
  slideSize,
  slidesThemeBlock,
  type ArtifactOp,
  type ArtifactSlide,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState, type MouseEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import { ArtifactFrame } from '../frame/artifact-frame'
import { FrameFilesDialog } from '../frame/frame-files'
import { SlideRail } from './slide-rail'
import { SlideShow } from './slide-show'
import { slidesTexts } from './slides-texts'

export { slidesTexts } from './slides-texts'

// «Презентация» in the cabinet (docs/plan/93-artifacts-trim.md, АТ8; docs/plan/88-artifacts.md,
// §7.13): the slide large in the middle, a slim rail of thumbnails, one toolbar — «Показать»,
// «Скачать» (PDF, PowerPoint), «Слайд» and «⋯» (Править текст, Файлы) —, the speaker notes folded
// under the slide. The frame of the slide comes without a toolbar of its own.

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

/** A file of the deck takes a picture of each slide: up to two minutes, asked every 2 s. */
const EXPORT_POLL_MS = 2000
const EXPORT_POLLS = 60

const newKey = () => `slide${uuidv7().replace(/-/g, '').slice(-8)}`

/** The speaker notes of a slide, folded: written on leaving the field, by its revision. */
function SlideNotes({
  artifactId,
  slide,
  noteRev,
  canEdit,
  onChanged,
}: {
  artifactId: string
  slide: ArtifactSlide
  noteRev: number | null
  canEdit: boolean
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(slide.notes)
  const [outcome, setOutcome] = useState<string | null>(null)
  const regionId = useId()

  async function save() {
    if (text === slide.notes || write.isPending) return
    setOutcome(slidesTexts.saving)
    try {
      await write.mutateAsync({
        batch: {
          artifactId,
          opId: uuidv7(),
          ops: [
            slide.noteKey !== null && noteRev !== null
              ? { op: 'replace', block: slide.noteKey, ifRev: noteRev, content: text }
              : { op: 'insert', after: null, parent: slide.key, kind: 'note', content: text },
          ],
        },
      })
      setOutcome(slidesTexts.saved)
      onChanged()
    } catch (error) {
      setOutcome(domainCodeOf(error) === 'ARTIFACT_STALE' ? slidesTexts.stale : slidesTexts.failed)
    }
  }

  // A reader sees nothing where there is nothing to read.
  if (!canEdit && slide.notes === '') return null

  return (
    <Box component="section" aria-label={slidesTexts.notes}>
      <ButtonBase
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        sx={{
          gap: 0.75,
          py: 0.5,
          px: 0.75,
          ml: -0.75,
          borderRadius: '6px',
          color: 'text.secondary',
          fontSize: 14,
          fontWeight: 500,
          '&:hover': { color: 'text.primary' },
          '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
        }}
      >
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        >
          <AppIcon name="chevron" size={14} />
        </Box>
        {slidesTexts.notes}
        {!open && slide.notes !== '' && (
          <Box component="span" aria-hidden sx={{ color: 'text.disabled', fontWeight: 400 }}>
            · {slide.notes.length > 48 ? `${slide.notes.slice(0, 48)}…` : slide.notes}
          </Box>
        )}
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box id={regionId} sx={{ pt: 1 }}>
          {canEdit ? (
            <>
              <TextField
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  setOutcome(null)
                }}
                onBlur={() => void save()}
                placeholder={slidesTexts.notesHint}
                multiline
                minRows={2}
                fullWidth
                size="small"
                slotProps={{ htmlInput: { 'aria-label': slidesTexts.notes } }}
              />
              {outcome && (
                <Typography
                  variant="caption"
                  role="status"
                  sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}
                >
                  {outcome}
                </Typography>
              )}
            </>
          ) : (
            <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
              {slide.notes || slidesTexts.notesEmpty}
            </Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  )
}

export function ArtifactSlides(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  const { artifact, onChanged, place } = props
  const trpc = useTRPC()
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const slides = artifactSlidesOf(artifact.blocks)
  const [chosen, setChosen] = useState<string | null>(null)
  const [showing, setShowing] = useState(false)
  const [editingText, setEditingText] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [menu, setMenu] = useState<{ name: 'download' | 'more'; anchor: HTMLElement } | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const client = useTRPCClient()
  const exportStart = useMutation(trpc.artifact.exportStart.mutationOptions())
  const [preparing, setPreparing] = useState<'pdf' | 'pptx' | null>(null)
  const thumbs = useQuery({
    ...trpc.artifact.canvasThumbs.queryOptions({ artifactId: artifact.id, seq: artifact.seq }),
    refetchInterval: (query) => (query.state.data?.pending ? 3000 : false),
    enabled: slides.length > 0,
  })
  const at = Math.max(
    0,
    slides.findIndex((slide) => slide.key === chosen),
  )
  const slide = slides[at] ?? null
  const compact = place === 'pane'
  const top = artifact.blocks.filter((block) => block.parent === null)
  const revOf = (key: string | null) =>
    key === null ? null : (artifact.blocks.find((block) => block.key === key)?.rev ?? null)
  const thumbOf = (key: string) =>
    thumbs.data?.thumbs.find((each) => each.frame === key && each.width === slideSize.width)?.url ??
    null
  const hasHtml = (key: string) =>
    artifact.blocks.some((block) => block.kind === 'html' && block.parent === key)

  async function apply(ops: ArtifactOp[]) {
    setProblem(null)
    try {
      await write.mutateAsync({ batch: { artifactId: artifact.id, opId: uuidv7(), ops } })
      onChanged()
      return true
    } catch (error) {
      setProblem(domainCodeOf(error) === 'ARTIFACT_STALE' ? slidesTexts.stale : slidesTexts.failed)
      return false
    }
  }

  /** «Скачать» → PDF or PowerPoint: core draws each slide and builds the file (88.25в). */
  async function download(format: 'pdf' | 'pptx') {
    setPreparing(format)
    setProblem(null)
    try {
      const { exportId } = await exportStart.mutateAsync({ artifactId: artifact.id, format })
      for (let poll = 0; poll < EXPORT_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS))
        const { state } = await client.artifact.exportStatus.query({ exportId })
        if (state === 'ready') {
          const link = document.createElement('a')
          link.href = `/api/artifact-exports/${exportId}`
          document.body.append(link)
          link.click()
          link.remove()
          return
        }
        if (state === 'failed') break
      }
      setProblem(slidesTexts.exportFailed)
    } catch {
      setProblem(slidesTexts.exportFailed)
    } finally {
      setPreparing(null)
    }
  }

  /** «Выше» / «Ниже» of a thumbnail: one `move` by the revision of the slide. */
  function move(index: number, direction: -1 | 1) {
    const moving = slides[index]
    const target = index + direction
    if (!moving || target < 0 || target >= slides.length) return
    let after: string | null
    if (direction === 1) after = slides[target]!.key
    else if (target > 0) after = slides[target - 1]!.key
    else {
      // To the front: right after what stands before the first slide (the theme stays first).
      const first = top.findIndex((block) => block.key === slides[0]!.key)
      after = first > 0 ? top[first - 1]!.key : null
    }
    const rev = revOf(moving.key)
    if (rev === null) return
    setChosen(moving.key)
    void apply([{ op: 'move', block: moving.key, ifRev: rev, after }])
  }

  async function remove(index: number) {
    const gone = slides[index]
    const rev = gone ? revOf(gone.key) : null
    setRemoving(null)
    if (!gone || rev === null) return
    const ok = await apply([{ op: 'delete', block: gone.key, ifRev: rev }])
    if (ok) setChosen(slides[index + 1]?.key ?? slides[index - 1]?.key ?? null)
  }

  /** «Добавить слайд»: the points layout of the theme after the chosen slide; the theme if none. */
  function add() {
    const key = newKey()
    const ops: ArtifactOp[] = []
    const styled = top.some((block) => block.kind === 'style')
    if (!styled)
      ops.push({
        op: 'insert',
        block: slidesThemeBlock.key,
        after: null,
        kind: 'style',
        content: slidesThemeBlock.content,
      })
    const after = slide?.key ?? (styled ? (top.at(-1)?.key ?? null) : slidesThemeBlock.key)
    ops.push(
      {
        op: 'insert',
        block: key,
        after,
        kind: 'frame',
        content: '',
        props: { name: slidesTexts.newSlide },
      },
      {
        op: 'insert',
        block: `${key}-html`,
        after: null,
        parent: key,
        kind: 'html',
        content: newSlideHtml,
      },
    )
    void apply(ops)
    setEditingText(false)
    setChosen(key)
  }

  const openMenu = (name: 'download' | 'more') => (event: MouseEvent<HTMLElement>) =>
    setMenu({ name, anchor: event.currentTarget })
  const closeMenu = () => setMenu(null)

  if (slides.length === 0)
    return (
      <Box
        sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, alignItems: 'flex-start', py: 4 }}
      >
        <Typography sx={{ color: 'text.secondary' }}>{slidesTexts.empty}</Typography>
        {canEdit && (
          <Button
            variant="outlined"
            startIcon={<AppIcon name="plus" size={16} />}
            onClick={add}
            disabled={write.isPending}
          >
            {slidesTexts.add}
          </Button>
        )}
        {problem && <Alert severity="error">{problem}</Alert>}
      </Box>
    )

  return (
    <Box
      sx={{
        display: 'grid',
        columnGap: 3,
        rowGap: 1.5,
        alignItems: 'start',
        gridTemplateColumns: compact
          ? 'minmax(0, 1fr)'
          : { xs: 'minmax(0, 1fr)', md: '132px minmax(0, 1fr)' },
        gridTemplateAreas: compact
          ? '"bar" "stage" "rail" "notes"'
          : { xs: '"bar" "stage" "rail" "notes"', md: '"rail bar" "rail stage" "rail notes"' },
        gridTemplateRows: compact ? undefined : { md: 'auto auto 1fr' },
      }}
    >
      <Box
        role="toolbar"
        aria-label={slidesTexts.slides}
        sx={{ gridArea: 'bar', display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
      >
        <Button
          variant="contained"
          startIcon={<AppIcon name="fullscreen" size={16} />}
          onClick={() => setShowing(true)}
        >
          {slidesTexts.show}
        </Button>
        <Button
          aria-haspopup="menu"
          aria-expanded={menu?.name === 'download'}
          disabled={preparing !== null}
          startIcon={<AppIcon name="download" size={16} />}
          endIcon={preparing === null ? <AppIcon name="down" size={14} /> : undefined}
          onClick={openMenu('download')}
        >
          {preparing === null ? slidesTexts.download : slidesTexts.preparing}
        </Button>
        <Box sx={{ flex: 1 }} />
        {editingText && (
          <Button variant="outlined" size="small" onClick={() => setEditingText(false)}>
            {slidesTexts.editDone}
          </Button>
        )}
        {canEdit && (
          <Button
            aria-label={slidesTexts.add}
            title={slidesTexts.add}
            startIcon={<AppIcon name="plus" size={16} />}
            onClick={add}
            disabled={write.isPending}
          >
            {slidesTexts.addShort}
          </Button>
        )}
        <Tooltip title={slidesTexts.more}>
          <IconButton
            aria-label={slidesTexts.more}
            aria-haspopup="menu"
            aria-expanded={menu?.name === 'more'}
            onClick={openMenu('more')}
          >
            <AppIcon name="more" size={18} />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={menu?.anchor ?? null} open={menu?.name === 'download'} onClose={closeMenu}>
          <MenuItem
            onClick={() => {
              closeMenu()
              void download('pdf')
            }}
          >
            {slidesTexts.pdf}
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMenu()
              void download('pptx')
            }}
          >
            {slidesTexts.pptx}
          </MenuItem>
        </Menu>
        <Menu anchorEl={menu?.anchor ?? null} open={menu?.name === 'more'} onClose={closeMenu}>
          {canEdit && (
            <MenuItem
              disabled={!slide || !hasHtml(slide.key)}
              onClick={() => {
                closeMenu()
                setEditingText(!editingText)
              }}
            >
              {editingText ? slidesTexts.editDone : slidesTexts.editText}
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              closeMenu()
              setFilesOpen(true)
            }}
          >
            {slidesTexts.files}
          </MenuItem>
        </Menu>
      </Box>
      <Box sx={{ gridArea: 'stage', minWidth: 0 }}>
        {problem && (
          <Alert severity="error" onClose={() => setProblem(null)} sx={{ mb: 1.5 }}>
            {problem}
          </Alert>
        )}
        {slide && (
          <>
            <ArtifactFrame
              key={`${slide.key}:${editingText ? 'text' : 'view'}`}
              {...props}
              frame={slide.key}
              slide={slideSize}
              bare
              startMode={editingText ? 'text' : 'view'}
            />
            <Typography
              variant="caption"
              sx={{ display: 'block', mt: 1, color: 'text.secondary', textAlign: 'center' }}
            >
              {slidesTexts.position(at + 1, slides.length, slide.name)}
            </Typography>
          </>
        )}
      </Box>
      <Box
        sx={{
          gridArea: 'rail',
          minWidth: 0,
          position: compact ? 'static' : { md: 'sticky' },
          top: compact ? undefined : { md: 16 },
        }}
      >
        <SlideRail
          slides={slides}
          at={at}
          compact={compact}
          thumbOf={thumbOf}
          canEdit={canEdit}
          busy={write.isPending}
          onChoose={(key) => {
            setChosen(key)
            setEditingText(false)
          }}
          onMove={move}
          onRemove={setRemoving}
        />
      </Box>
      <Box sx={{ gridArea: 'notes', minWidth: 0 }}>
        {slide && (
          <SlideNotes
            // Another slide, or notes changed by someone else: the draft starts again.
            key={`${slide.key}:${slide.notes}`}
            artifactId={artifact.id}
            slide={slide}
            noteRev={revOf(slide.noteKey)}
            canEdit={canEdit}
            onChanged={onChanged}
          />
        )}
      </Box>
      <FrameFilesDialog
        artifact={artifact}
        canEdit={canEdit}
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
      />
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        aria-labelledby="slide-remove-title"
      >
        <DialogTitle id="slide-remove-title">{slidesTexts.removeTitle}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {slidesTexts.removeBody(slides[removing ?? 0]?.name ?? '')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{slidesTexts.cancel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => removing !== null && void remove(removing)}
          >
            {slidesTexts.remove}
          </Button>
        </DialogActions>
      </Dialog>
      {showing && (
        <SlideShow
          artifactId={artifact.id}
          seq={artifact.seq}
          slides={slides}
          start={at}
          thumbOf={thumbOf}
          onClose={() => setShowing(false)}
        />
      )}
    </Box>
  )
}
