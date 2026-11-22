'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  artifactRoleAtLeast,
  artifactSlidesOf,
  slideSize,
  type ArtifactOp,
  type ArtifactSlide,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import { ArtifactMockup } from '../mockup/artifact-mockup'
import { ViewFrame } from '../mockup/view-frame'

// «Презентация» in the cabinet (docs/plan/88-artifacts.md, §7.7, §7.13; slice 88.25б): the strip of
// slides by the thumbnails core draws, the chosen slide large as the frame of a mockup at 1280×720 —
// «Править текст» included —, its speaker notes, the order of the slides, a new one, and «Показать»:
// the slides one by one over the whole screen, by the arrows. No reveal.js: the frames are shown.

export const slidesTexts = Object.freeze({
  empty: 'Слайдов пока нет. Попросите агента собрать презентацию или добавьте слайд.',
  slides: 'Слайды',
  show: 'Показать',
  add: 'Добавить слайд',
  up: 'Выше',
  down: 'Ниже',
  notes: 'Заметки докладчика',
  notesEmpty: 'Заметок нет.',
  save: 'Сохранить заметки',
  saved: 'Заметки сохранены.',
  failed: 'Не получилось сохранить. Попробуйте ещё раз.',
  stale: 'Слайды только что изменили. Обновите и повторите.',
  close: 'Закрыть показ',
  previous: 'Предыдущий слайд',
  next: 'Следующий слайд',
  newSlide: 'Новый слайд',
  pdf: 'Скачать PDF',
  pptx: 'Скачать PPTX',
  preparing: 'Готовим файл…',
  exportFailed: 'Не получилось подготовить файл. Попробуйте ещё раз.',
  newSlideHtml:
    '<section class="slide"><h2>Заголовок слайда</h2><p>Две-три короткие строки о главном.</p></section>',
  of: (at: number, all: number) => `${at} из ${all}`,
})

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

/** A file of the deck takes a picture of each slide: up to two minutes, asked every 2 s. */
const EXPORT_POLL_MS = 2000
const EXPORT_POLLS = 60

const newKey = () => `slide${uuidv7().replace(/-/g, '').slice(-8)}`

/** The slides over the whole screen: one at a time, scaled to it, by the arrows and Esc. */
function SlideShow({
  artifactId,
  seq,
  slides,
  start,
  onClose,
}: {
  artifactId: string
  seq: number
  slides: readonly ArtifactSlide[]
  start: number
  onClose: () => void
}) {
  const trpc = useTRPC()
  const [at, setAt] = useState(start)
  const [screen, setScreen] = useState({ width: 1280, height: 720 })
  const slide = slides[at]!
  const frame = useQuery({
    ...trpc.artifact.frame.queryOptions({ artifactId, mode: 'view', seq, frame: slide.key }),
    staleTime: 4 * 60_000,
  })

  useEffect(() => {
    const measure = () => setScreen({ width: window.innerWidth, height: window.innerHeight })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown')
        setAt((current) => Math.min(current + 1, slides.length - 1))
      if (event.key === 'ArrowLeft' || event.key === 'PageUp')
        setAt((current) => Math.max(current - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [slides.length])

  const scale = Math.min(screen.width / slideSize.width, (screen.height - 56) / slideSize.height)
  return (
    <Dialog
      fullScreen
      open
      onClose={onClose}
      slotProps={{ paper: { 'aria-label': slidesTexts.show } }}
    >
      <Box
        sx={{
          bgcolor: '#000',
          color: '#fff',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        {frame.data && (
          <ViewFrame
            key={slide.key}
            src={frame.data.url}
            width={slideSize.width}
            fixedHeight={slideSize.height}
            scale={scale}
            title={slide.name}
          />
        )}
        <Box
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, py: 1 }}
        >
          <IconButton
            aria-label={slidesTexts.previous}
            disabled={at === 0}
            onClick={() => setAt(at - 1)}
            sx={{ color: '#fff' }}
          >
            ←
          </IconButton>
          <Typography variant="body2" aria-live="polite">
            {slidesTexts.of(at + 1, slides.length)}
          </Typography>
          <IconButton
            aria-label={slidesTexts.next}
            disabled={at === slides.length - 1}
            onClick={() => setAt(at + 1)}
            sx={{ color: '#fff' }}
          >
            →
          </IconButton>
          <Button onClick={onClose} sx={{ color: '#fff' }}>
            {slidesTexts.close}
          </Button>
        </Box>
      </Box>
    </Dialog>
  )
}

/** The speaker notes of a slide: read, and written by «Правит» and the owner. */
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
  const [text, setText] = useState(slide.notes)
  const [outcome, setOutcome] = useState<string | null>(null)

  async function save() {
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

  return (
    <Box component="section" aria-label={slidesTexts.notes}>
      <Typography component="h3" sx={{ fontSize: 14, fontWeight: 650, mb: 0.5 }}>
        {slidesTexts.notes}
      </Typography>
      {canEdit ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
          <TextField
            value={text}
            onChange={(event) => setText(event.target.value)}
            multiline
            minRows={2}
            fullWidth
            slotProps={{ htmlInput: { 'aria-label': slidesTexts.notes } }}
          />
          <Button
            size="small"
            disabled={write.isPending || text === slide.notes}
            onClick={() => void save()}
          >
            {slidesTexts.save}
          </Button>
          {outcome && <Typography variant="body2">{outcome}</Typography>}
        </Box>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
          {slide.notes || slidesTexts.notesEmpty}
        </Typography>
      )}
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
  const revOf = (key: string | null) =>
    key === null ? null : (artifact.blocks.find((block) => block.key === key)?.rev ?? null)
  const thumbOf = (key: string) =>
    thumbs.data?.thumbs.find((each) => each.frame === key && each.width === slideSize.width)?.url ??
    null

  async function apply(ops: ArtifactOp[]) {
    setProblem(null)
    try {
      await write.mutateAsync({ batch: { artifactId: artifact.id, opId: uuidv7(), ops } })
      onChanged()
    } catch (error) {
      setProblem(domainCodeOf(error) === 'ARTIFACT_STALE' ? slidesTexts.stale : slidesTexts.failed)
    }
  }

  /** «Скачать PDF» / «Скачать PPTX»: core draws each slide and builds the file (88.25в). */
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

  function move(direction: -1 | 1) {
    if (!slide) return
    const target = at + direction
    if (target < 0 || target >= slides.length) return
    // After the slide before the place it goes to; to the front — after nothing but the style.
    const after = direction === -1 ? (slides[target - 1]?.key ?? null) : slides[target]!.key
    const rev = revOf(slide.key)
    if (rev === null) return
    void apply([{ op: 'move', block: slide.key, ifRev: rev, after }])
  }

  function add() {
    const key = newKey()
    void apply([
      {
        op: 'insert',
        block: key,
        after: slide?.key ?? null,
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
        content: slidesTexts.newSlideHtml,
      },
    ])
    setChosen(key)
  }

  if (slides.length === 0)
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
        <Typography sx={{ color: 'text.secondary' }}>{slidesTexts.empty}</Typography>
        {canEdit && <Button onClick={add}>{slidesTexts.add}</Button>}
      </Box>
    )

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: place === 'pane' ? 'column' : 'row',
        gap: 2,
        alignItems: 'flex-start',
      }}
    >
      <Box
        component="nav"
        aria-label={slidesTexts.slides}
        sx={{
          display: 'flex',
          flexDirection: place === 'pane' ? 'row' : 'column',
          gap: 1,
          flex: '0 0 auto',
          overflow: 'auto',
          maxWidth: place === 'pane' ? '100%' : 200,
          maxHeight: place === 'pane' ? undefined : '80vh',
        }}
      >
        {slides.map((each, index) => {
          const url = thumbOf(each.key)
          return (
            <Box
              key={each.key}
              component="button"
              type="button"
              aria-current={index === at ? 'true' : undefined}
              aria-label={`${index + 1}. ${each.name}`}
              onClick={() => setChosen(each.key)}
              sx={{
                flex: '0 0 auto',
                width: 176,
                p: 0.5,
                border: 2,
                borderColor: index === at ? 'primary.main' : 'divider',
                borderRadius: '8px',
                bgcolor: 'background.paper',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Box
                sx={{
                  width: 160,
                  height: 90,
                  bgcolor: '#fff',
                  borderRadius: '4px',
                  overflow: 'hidden',
                }}
              >
                {url && (
                  <Box
                    component="img"
                    src={url}
                    alt=""
                    sx={{ width: 160, height: 90, display: 'block', objectFit: 'cover' }}
                  />
                )}
              </Box>
              <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }} noWrap>
                {index + 1}. {each.name}
              </Typography>
            </Box>
          )
        })}
      </Box>
      <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <Button variant="contained" onClick={() => setShowing(true)}>
            {slidesTexts.show}
          </Button>
          <Button onClick={() => void download('pdf')} disabled={preparing !== null}>
            {preparing === 'pdf' ? slidesTexts.preparing : slidesTexts.pdf}
          </Button>
          <Button onClick={() => void download('pptx')} disabled={preparing !== null}>
            {preparing === 'pptx' ? slidesTexts.preparing : slidesTexts.pptx}
          </Button>
          {canEdit && (
            <>
              <Button onClick={add} disabled={write.isPending}>
                {slidesTexts.add}
              </Button>
              <Button onClick={() => move(-1)} disabled={write.isPending || at === 0}>
                {slidesTexts.up}
              </Button>
              <Button
                onClick={() => move(1)}
                disabled={write.isPending || at === slides.length - 1}
              >
                {slidesTexts.down}
              </Button>
            </>
          )}
        </Box>
        {problem && <Alert severity="error">{problem}</Alert>}
        {slide && (
          <>
            <ArtifactMockup key={slide.key} {...props} frame={slide.key} slide={slideSize} />
            <SlideNotes
              // Another slide, or notes changed by someone else: the draft starts again.
              key={`${slide.key}:${slide.notes}`}
              artifactId={artifact.id}
              slide={slide}
              noteRev={revOf(slide.noteKey)}
              canEdit={canEdit}
              onChanged={onChanged}
            />
          </>
        )}
      </Box>
      {showing && (
        <SlideShow
          artifactId={artifact.id}
          seq={artifact.seq}
          slides={slides}
          start={at}
          onClose={() => setShowing(false)}
        />
      )}
    </Box>
  )
}
