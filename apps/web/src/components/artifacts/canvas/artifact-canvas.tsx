'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import {
  ARTIFACT_SANDBOX,
  artifactMention,
  artifactRoleAtLeast,
  canvasGap,
  canvasLiveFrames,
  canvasNotesOf,
  canvasScreensOf,
  canvasViews,
  type CanvasBlock,
  type CanvasNote,
  type CanvasScreen,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { keepChatDraft } from '@/components/chat/chat-draft'
import { useTRPC } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import { ArtifactMockup } from '../mockup/artifact-mockup'
import { canvasTexts } from './canvas-texts'

// «Холст» (docs/plan/88-artifacts.md, Ар8, Ар49, §7.7; spike 6; board C-canvas; slice 88.15): a
// board of the screens of a site on a CSS transform. A screen is one adaptive frame the board shows
// twice — at the width of a computer and of a phone —; both views are thumbnails the renderer drew,
// and only frames in view at a scale of 30 % and more become live, four at most, hidden while the
// board zooms. A frame on the board never takes the pointer: a cover lies over it, and its content
// is worked with only in «Открыть». Narrower than 600 px the board is a list of thumbnails of the
// phone view (Ар49).

type Tool = 'select' | 'hand' | 'note' | 'pin'

const NARROW_PX = 600
const MIN_SCALE = 0.05
const MAX_SCALE = 2
const PHONE_X = canvasViews[0].width + canvasGap
const SCREEN_WIDTH = PHONE_X + canvasViews[1].width
const NOTE_COLORS: Readonly<Record<string, string>> = Object.freeze({
  yellow: '#fff4b8',
  green: '#d9f2d0',
  blue: '#d6e8fb',
  pink: '#fbdbe6',
  grey: '#ececec',
})

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

const newKey = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

interface View {
  x: number
  y: number
  scale: number
}

/** The height of a view: from its thumbnail when it is drawn, else the window of the device. */
const viewHeight = (width: number, natural: number | undefined) =>
  natural ?? canvasViews.find((view) => view.width === width)!.height

/** A live frame on the board: the view of the mockup's frame, never taking the pointer. */
function LiveFrame({
  artifactId,
  seq,
  frame,
  width,
  height,
  title,
}: {
  artifactId: string
  seq: number
  frame: string
  width: number
  height: number
  title: string
}) {
  const trpc = useTRPC()
  const source = useQuery({
    ...trpc.artifact.frame.queryOptions({ artifactId, mode: 'view', seq, frame }),
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
  })
  if (!source.data) return null
  return (
    <iframe
      key={source.data.url}
      src={source.data.url}
      title={title}
      sandbox={ARTIFACT_SANDBOX}
      referrerPolicy="no-referrer"
      data-artifact-frame="canvas"
      tabIndex={-1}
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        border: 0,
        background: '#fff',
        // Spike 6: the board takes the pointer, never the frame; a cover lies over it too.
        pointerEvents: 'none',
      }}
    />
  )
}

export function ArtifactCanvas({ artifact, onChanged, place }: ArtifactBodyProps) {
  const trpc = useTRPC()
  const router = useRouter()
  const me = useQuery(trpc.user.me.queryOptions())
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const blocks = artifact.blocks as unknown as CanvasBlock[]
  const screens = useMemo(() => canvasScreensOf(blocks), [blocks])
  const notes = useMemo(() => canvasNotesOf(blocks), [blocks])
  const thumbs = useQuery({
    ...trpc.artifact.canvasThumbs.queryOptions({ artifactId: artifact.id, seq: artifact.seq }),
    refetchInterval: (query) => (query.state.data?.pending ? 3000 : false),
  })
  const thumbOf = (frame: string, width: number) =>
    thumbs.data?.thumbs.find((each) => each.frame === frame && each.width === width)?.url ?? null

  const area = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ x: 40, y: 40, scale: 0.25 })
  const [zooming, setZooming] = useState(false)
  const zoomTimer = useRef<number | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ frame: string } | null>(null)
  const [noteEdit, setNoteEdit] = useState<CanvasNote | null>(null)
  const [noteText, setNoteText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const drag = useRef<
    | { kind: 'pan'; startX: number; startY: number; from: View }
    | { kind: 'move'; frame: string; startX: number; startY: number; fromX: number; fromY: number }
    | null
  >(null)
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})

  useEffect(() => {
    const element = area.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry?.contentRect.width ?? 0, height: entry?.contentRect.height ?? 0 }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const narrow = size.width > 0 && size.width < NARROW_PX
  const placeOf = (screen: CanvasScreen) => moved[screen.key] ?? { x: screen.x, y: screen.y }
  const boardHeightOf = (screen: CanvasScreen) =>
    Math.max(
      viewHeight(1440, heights[`${screen.key}:1440`]),
      viewHeight(390, heights[`${screen.key}:390`]),
    )

  const fit = useCallback(() => {
    if (screens.length === 0 || size.width === 0) return
    const xs = screens.map((screen) => screen.x)
    const ys = screens.map((screen) => screen.y)
    const right = Math.max(...xs) + SCREEN_WIDTH
    const bottom = Math.max(...ys) + 1800
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    const scale = Math.max(
      MIN_SCALE,
      Math.min(0.5, (size.width - 80) / (right - left), (size.height - 80) / (bottom - top)),
    )
    // The whole canvas in the middle of the board: a zoom around the middle lands on a screen.
    setView({
      x: (size.width - (right - left) * scale) / 2 - left * scale,
      y: Math.max(40, (size.height - (bottom - top) * scale) / 2) - top * scale,
      scale,
    })
  }, [screens, size.width, size.height])
  const fitted = useRef(false)
  useEffect(() => {
    if (!fitted.current && screens.length > 0 && size.width > 0) {
      fitted.current = true
      fit()
    }
  }, [fit, screens.length, size.width])

  // Which frames are live (§7.7): in view, at 30 % and more, at most four, none while zooming.
  const live = useMemo(() => {
    const visible = screens.flatMap((screen) => {
      const at = placeOf(screen)
      return canvasViews.map((each) => {
        const x = view.x + (at.x + (each.width === 1440 ? 0 : PHONE_X)) * view.scale
        const y = view.y + at.y * view.scale
        const w = each.width * view.scale
        const h = viewHeight(each.width, heights[`${screen.key}:${each.width}`]) * view.scale
        const seenW = Math.max(0, Math.min(x + w, size.width) - Math.max(x, 0))
        const seenH = Math.max(0, Math.min(y + h, size.height) - Math.max(y, 0))
        return {
          key: `${screen.key}:${each.width}`,
          share: w * h > 0 ? (seenW * seenH) / (w * h) : 0,
        }
      })
    })
    return new Set(canvasLiveFrames({ visible, scale: view.scale, zooming }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens, view, zooming, size, heights, moved])

  const zoomTo = (scale: number, around?: { x: number; y: number }) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
    const center = around ?? { x: size.width / 2, y: size.height / 2 }
    setView((current) => ({
      scale: next,
      x: center.x - ((center.x - current.x) * next) / current.scale,
      y: center.y - ((center.y - current.y) * next) / current.scale,
    }))
    setZooming(true)
    if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current)
    zoomTimer.current = window.setTimeout(() => setZooming(false), 200)
  }

  // The wheel and the pinch go to the board, never to a frame (spike 6: a cover over each frame).
  useEffect(() => {
    const element = area.current
    if (!element || narrow) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey)
        zoomTo(view.scale * Math.exp(-event.deltaY / 300), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
      else
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  })

  async function apply(ops: unknown[], opId: string) {
    setNotice(null)
    try {
      await write.mutateAsync({ batch: { artifactId: artifact.id, opId, ops } })
      onChanged()
      return true
    } catch (error) {
      setNotice(
        domainCodeOf(error) === 'ARTIFACT_BLOCK_HELD' ? canvasTexts.held : canvasTexts.failed,
      )
      return false
    }
  }

  const lastTop = () => {
    const top = blocks.filter((block) => block.parent === null)
    return top.at(-1)?.key ?? null
  }
  const boardPoint = (clientX: number, clientY: number) => {
    const rect = area.current!.getBoundingClientRect()
    return {
      x: Math.round((clientX - rect.left - view.x) / view.scale),
      y: Math.round((clientY - rect.top - view.y) / view.scale),
    }
  }

  async function newScreen() {
    const frame = newKey('screen')
    const at = screens.length
      ? { x: Math.max(...screens.map((s) => s.x)), y: Math.max(...screens.map((s) => s.y)) + 2400 }
      : { x: 0, y: 0 }
    await apply(
      [
        {
          op: 'insert',
          block: frame,
          after: lastTop(),
          kind: 'frame',
          content: '',
          props: { name: `${canvasTexts.newScreenName} ${screens.length + 1}`, ...at },
        },
        {
          op: 'insert',
          block: `${frame}-html`,
          after: null,
          parent: frame,
          kind: 'html',
          content: canvasTexts.newScreenHtml,
        },
      ],
      newKey('new-screen'),
    )
    setSelected(frame)
  }

  async function makeVariant(screen: CanvasScreen) {
    const frame = newKey('screen')
    const parts = blocks.filter((block) => block.parent === screen.key && block.kind !== 'note')
    const letters = screens
      .filter((each) => each.name === screen.name)
      .map((each) => each.variant ?? 'А')
    const next = 'АБВГДЕЖЗИК'.split('').find((letter) => !letters.includes(letter)) ?? 'Б'
    const source = blocks.find((block) => block.key === screen.key)!
    const ops: unknown[] = []
    if (screen.variant === null)
      ops.push({
        op: 'replace',
        block: screen.key,
        ifRev: source.rev,
        content: '',
        props: { name: screen.name, variant: 'А' },
      })
    const at = placeOf(screen)
    ops.push({
      op: 'insert',
      block: frame,
      after: screen.key,
      kind: 'frame',
      content: '',
      props: { name: screen.name, variant: next, x: at.x + SCREEN_WIDTH + canvasGap * 2, y: at.y },
    })
    let after: string | null = null
    for (const part of parts) {
      const key = `${frame}-${part.kind}-${ops.length}`
      ops.push({
        op: 'insert',
        block: key,
        after,
        parent: frame,
        kind: part.kind,
        content: part.content ?? '',
      })
      after = key
    }
    if (await apply(ops, newKey('variant'))) setSelected(frame)
  }

  async function choose(screen: CanvasScreen) {
    const same = screens.filter((each) => each.name === screen.name)
    await apply(
      same.map((each) => ({
        op: 'props',
        block: each.key,
        props: { chosen: each.key === screen.key },
      })),
      newKey('choose'),
    )
  }

  const editInChat = (screen: CanvasScreen) => {
    const userId = me.data?.id
    if (userId)
      keepChatDraft(userId, canvasTexts.chatDraft(artifactMention(artifact.id), screen.name))
    router.push(artifact.project ? `/chats/new?project=${artifact.project.id}` : '/chats/new')
  }

  async function addNote(at: { x: number; y: number }, frame: CanvasScreen | null) {
    const key = newKey('note')
    const point = frame
      ? {
          // A pin: its place in per cent of the computer view of its screen.
          x: Math.round(((at.x - placeOf(frame).x) / canvasViews[0].width) * 100),
          y: Math.round(
            ((at.y - placeOf(frame).y) / viewHeight(1440, heights[`${frame.key}:1440`])) * 100,
          ),
        }
      : at
    await apply(
      [
        {
          op: 'insert',
          block: key,
          after: frame
            ? (blocks.filter((b) => b.parent === frame.key).at(-1)?.key ?? null)
            : lastTop(),
          ...(frame ? { parent: frame.key } : {}),
          kind: 'note',
          content: frame ? canvasTexts.pinText : canvasTexts.noteText,
          props: { ...point, color: 'yellow' },
        },
      ],
      newKey('note'),
    )
    setTool('select')
  }

  const screenAt = (point: { x: number; y: number }) =>
    screens.find((screen) => {
      const at = placeOf(screen)
      return (
        point.x >= at.x &&
        point.x <= at.x + SCREEN_WIDTH &&
        point.y >= at.y &&
        point.y <= at.y + boardHeightOf(screen)
      )
    }) ?? null

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    const point = boardPoint(event.clientX, event.clientY)
    const hit = screenAt(point)
    if (tool === 'note' && canEdit) return void addNote(point, null)
    if (tool === 'pin' && canEdit && hit) return void addNote(point, hit)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'hand' || event.button === 1 || !hit) {
      drag.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, from: view }
      if (!hit) setSelected(null)
      return
    }
    setSelected(hit.key)
    if (canEdit) {
      const at = placeOf(hit)
      drag.current = {
        kind: 'move',
        frame: hit.key,
        startX: event.clientX,
        startY: event.clientY,
        fromX: at.x,
        fromY: at.y,
      }
    }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const now = drag.current
    if (!now) return
    const dx = event.clientX - now.startX
    const dy = event.clientY - now.startY
    if (now.kind === 'pan') setView({ ...now.from, x: now.from.x + dx, y: now.from.y + dy })
    else
      setMoved((current) => ({
        ...current,
        [now.frame]: {
          x: Math.round(now.fromX + dx / view.scale),
          y: Math.round(now.fromY + dy / view.scale),
        },
      }))
  }
  const onPointerUp = () => {
    const now = drag.current
    drag.current = null
    if (now?.kind !== 'move') return
    const to = moved[now.frame]
    if (!to || (to.x === now.fromX && to.y === now.fromY)) return
    void apply([{ op: 'props', block: now.frame, props: to }], newKey('move')).finally(() =>
      setMoved((current) => {
        const { [now.frame]: _gone, ...rest } = current
        return rest
      }),
    )
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const at = screens.findIndex((screen) => screen.key === selected)
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(screens[Math.min(screens.length - 1, at + 1)]?.key ?? null)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(screens[Math.max(0, at - 1)]?.key ?? null)
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault()
      setOpened({ frame: selected })
    } else if (event.key === '+' || event.key === '=') zoomTo(view.scale * 1.25)
    else if (event.key === '-') zoomTo(view.scale / 1.25)
    else if (event.key === '0') fit()
    else if (event.key === 'Escape') setSelected(null)
  }

  const chosen = screens.find((screen) => screen.key === selected) ?? null
  const openedScreen = screens.find((screen) => screen.key === opened?.frame) ?? null

  const saveNote = async () => {
    if (!noteEdit) return
    const block = blocks.find((each) => each.key === noteEdit.key)
    if (block && noteText.trim() !== '' && noteText !== noteEdit.text)
      await apply(
        [{ op: 'replace', block: noteEdit.key, ifRev: block.rev, content: noteText.trim() }],
        newKey('note-text'),
      )
    setNoteEdit(null)
  }
  const removeNote = async () => {
    if (!noteEdit) return
    const block = blocks.find((each) => each.key === noteEdit.key)
    if (block)
      await apply([{ op: 'delete', block: noteEdit.key, ifRev: block.rev }], newKey('note-gone'))
    setNoteEdit(null)
  }

  const thumbImage = (screen: CanvasScreen, width: number, scaleTo: number) => {
    const url = thumbOf(screen.key, width)
    if (!url)
      return (
        <Box
          sx={{
            width: width * scaleTo,
            height: viewHeight(width, undefined) * scaleTo,
            bgcolor: 'background.paper',
            display: 'grid',
            placeItems: 'center',
            color: 'text.secondary',
            fontSize: 14 / Math.max(scaleTo, 0.1),
          }}
        >
          {canvasTexts.drawing}
        </Box>
      )
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={width * scaleTo}
        draggable={false}
        onLoad={(event) => {
          // The height of the view at its width, from the thumbnail the renderer drew (Ар8).
          const image = event.currentTarget
          const ratio = image.naturalHeight / image.naturalWidth
          const key = `${screen.key}:${width}`
          const height = Math.round(width * ratio)
          setHeights((current) =>
            current[key] === height ? current : { ...current, [key]: height },
          )
        }}
        style={{ display: 'block', width: width * scaleTo, height: 'auto', userSelect: 'none' }}
      />
    )
  }

  const header = (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mb: 1 }}>
      {!narrow && (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={tool}
          aria-label={canvasTexts.tools}
          onChange={(_event, value: Tool | null) => value && setTool(value)}
        >
          <ToggleButton value="select">{canvasTexts.select}</ToggleButton>
          <ToggleButton value="hand">{canvasTexts.hand}</ToggleButton>
          {canEdit && <ToggleButton value="note">{canvasTexts.note}</ToggleButton>}
          {canEdit && <ToggleButton value="pin">{canvasTexts.pin}</ToggleButton>}
        </ToggleButtonGroup>
      )}
      {canEdit && (
        <Button
          size="small"
          variant="outlined"
          onClick={() => void newScreen()}
          disabled={write.isPending}
        >
          {canvasTexts.newScreen}
        </Button>
      )}
      {!narrow && (
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', ml: 'auto' }}>
          <Button
            size="small"
            onClick={() => zoomTo(view.scale / 1.25)}
            aria-label={canvasTexts.zoomOut}
          >
            −
          </Button>
          <Typography variant="body2" sx={{ minWidth: 48, textAlign: 'center' }} aria-live="polite">
            {canvasTexts.scale(Math.round(view.scale * 100))}
          </Typography>
          <Button
            size="small"
            onClick={() => zoomTo(view.scale * 1.25)}
            aria-label={canvasTexts.zoomIn}
          >
            +
          </Button>
          <Button size="small" onClick={fit}>
            {canvasTexts.fit}
          </Button>
        </Box>
      )}
    </Box>
  )

  const selectedBar = chosen && (
    <Box
      role="toolbar"
      aria-label={canvasTexts.selected}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mb: 1 }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {canvasTexts.screenLabel(chosen.name, chosen.variant)}
      </Typography>
      <Button size="small" onClick={() => editInChat(chosen)}>
        {canvasTexts.editInChat}
      </Button>
      {canEdit && (
        <Button size="small" onClick={() => void makeVariant(chosen)} disabled={write.isPending}>
          {canvasTexts.makeVariant}
        </Button>
      )}
      {canEdit && chosen.variant !== null && !chosen.chosen && (
        <Button size="small" onClick={() => void choose(chosen)}>
          {canvasTexts.choose}
        </Button>
      )}
      <Button size="small" variant="contained" onClick={() => setOpened({ frame: chosen.key })}>
        {canvasTexts.open}
      </Button>
    </Box>
  )

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {header}
      {selectedBar}
      {notice && (
        <Alert severity="error" onClose={() => setNotice(null)} sx={{ mb: 1 }}>
          {notice}
        </Alert>
      )}
      <Box
        ref={area}
        sx={{
          position: 'relative',
          height: narrow ? 'auto' : place === 'pane' ? 560 : 'min(78vh, 900px)',
          overflow: narrow ? 'visible' : 'hidden',
          borderRadius: '12px',
          border: 1,
          borderColor: 'divider',
          bgcolor: 'action.hover',
          touchAction: narrow ? 'auto' : 'none',
        }}
      >
        {screens.length === 0 ? (
          <Typography sx={{ p: 3, color: 'text.secondary' }}>{canvasTexts.empty}</Typography>
        ) : narrow ? (
          <Box
            component="ul"
            aria-label={canvasTexts.list}
            sx={{ listStyle: 'none', m: 0, p: 1.5, display: 'grid', gap: 1.5 }}
          >
            {screens.map((screen) => (
              <Box component="li" key={screen.key}>
                <Button
                  onClick={() => setOpened({ frame: screen.key })}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    p: 0,
                    width: '100%',
                    textTransform: 'none',
                  }}
                  aria-label={`${canvasTexts.open}: ${canvasTexts.screenLabel(screen.name, screen.variant)}`}
                >
                  <Box
                    sx={{
                      borderRadius: '10px',
                      overflow: 'hidden',
                      border: 1,
                      borderColor: 'divider',
                      maxHeight: 422,
                      alignSelf: 'center',
                    }}
                  >
                    {thumbImage(screen, 390, 0.5)}
                  </Box>
                  <Typography variant="body2" sx={{ mt: 0.5, color: 'text.primary' }}>
                    {canvasTexts.screenLabel(screen.name, screen.variant)}
                  </Typography>
                </Button>
              </Box>
            ))}
          </Box>
        ) : (
          <Box
            role="application"
            aria-label={`${canvasTexts.board}. ${canvasTexts.boardHint}`}
            tabIndex={0}
            data-testid="canvas-board"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(event) => {
              const hit = screenAt(boardPoint(event.clientX, event.clientY))
              if (hit) setOpened({ frame: hit.key })
            }}
            sx={{
              position: 'absolute',
              inset: 0,
              cursor: tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair',
              outline: 'none',
              '&:focus-visible': { boxShadow: 'inset 0 0 0 2px', color: 'primary.main' },
            }}
          >
            <Box
              data-testid="canvas-surface"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                transformOrigin: '0 0',
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              }}
            >
              {screens.map((screen) => {
                const at = placeOf(screen)
                return (
                  <Box
                    key={screen.key}
                    data-testid="canvas-screen"
                    data-screen={screen.key}
                    aria-selected={screen.key === selected}
                    sx={{ position: 'absolute', left: at.x, top: at.y }}
                  >
                    <Typography
                      component="div"
                      sx={{
                        position: 'absolute',
                        top: -56,
                        left: 0,
                        fontSize: 32,
                        fontWeight: 650,
                        color: 'text.primary',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {canvasTexts.screenLabel(screen.name, screen.variant)}
                      {screen.chosen ? ` · ${canvasTexts.chosen}` : ''}
                    </Typography>
                    {canvasViews.map((each) => {
                      const key = `${screen.key}:${each.width}`
                      const height = viewHeight(each.width, heights[key])
                      const isLive = live.has(key)
                      return (
                        <Box
                          key={each.width}
                          sx={{
                            position: 'absolute',
                            left: each.width === 1440 ? 0 : PHONE_X,
                            top: 0,
                            width: each.width,
                            height,
                            overflow: 'hidden',
                            bgcolor: '#fff',
                            borderRadius: '8px',
                            boxShadow:
                              screen.key === selected
                                ? '0 0 0 8px rgba(47, 93, 80, 0.9)'
                                : '0 4px 24px rgba(0,0,0,0.12)',
                          }}
                        >
                          {thumbImage(screen, each.width, 1)}
                          {isLive && (
                            <Box
                              sx={{
                                position: 'absolute',
                                inset: 0,
                                visibility: zooming ? 'hidden' : 'visible',
                              }}
                            >
                              <LiveFrame
                                artifactId={artifact.id}
                                seq={artifact.seq}
                                frame={screen.key}
                                width={each.width}
                                height={height}
                                title={`${canvasTexts.live}: ${screen.name}, ${each.width === 1440 ? canvasTexts.desktop : canvasTexts.phone}`}
                              />
                            </Box>
                          )}
                          {/* The cover: WebKit on macOS gives a frame the wheel even with pointer-events: none. */}
                          <Box data-canvas-cover sx={{ position: 'absolute', inset: 0 }} />
                        </Box>
                      )
                    })}
                    {notes
                      .filter((note) => note.frame === screen.key)
                      .map((note) => (
                        <Box
                          key={note.key}
                          role="button"
                          tabIndex={-1}
                          aria-label={note.text}
                          data-testid="canvas-pin"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => {
                            setNoteEdit(note)
                            setNoteText(note.text)
                          }}
                          sx={{
                            position: 'absolute',
                            left: (note.x / 100) * canvasViews[0].width - 24,
                            top:
                              (note.y / 100) * viewHeight(1440, heights[`${screen.key}:1440`]) - 24,
                            width: 48,
                            height: 48,
                            borderRadius: '50% 50% 50% 0',
                            bgcolor: '#e07a3f',
                            border: '4px solid #fff',
                            cursor: 'pointer',
                          }}
                        />
                      ))}
                  </Box>
                )
              })}
              {notes
                .filter((note) => note.frame === null)
                .map((note) => (
                  <Box
                    key={note.key}
                    role="note"
                    data-testid="canvas-note"
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      setNoteEdit(note)
                      setNoteText(note.text)
                    }}
                    sx={{
                      position: 'absolute',
                      left: note.x,
                      top: note.y,
                      width: 360,
                      minHeight: 200,
                      p: 3,
                      fontSize: 28,
                      bgcolor: NOTE_COLORS[note.color] ?? NOTE_COLORS.yellow,
                      boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      cursor: 'text',
                    }}
                  >
                    {note.text}
                  </Box>
                ))}
            </Box>
          </Box>
        )}
      </Box>
      <Dialog
        open={openedScreen !== null}
        onClose={() => setOpened(null)}
        fullScreen
        aria-labelledby="canvas-open-title"
      >
        {openedScreen && (
          <>
            <DialogTitle
              id="canvas-open-title"
              sx={{ display: 'flex', alignItems: 'center', gap: 2 }}
            >
              <Box sx={{ flex: 1 }}>
                {canvasTexts.screenLabel(openedScreen.name, openedScreen.variant)}
              </Box>
              <Button onClick={() => setOpened(null)}>{canvasTexts.close}</Button>
            </DialogTitle>
            <DialogContent>
              <ArtifactMockup
                artifact={artifact}
                presence={null}
                onChanged={onChanged}
                place={narrow ? 'pane' : 'page'}
                frame={openedScreen.key}
              />
            </DialogContent>
          </>
        )}
      </Dialog>
      <Dialog open={noteEdit !== null} onClose={() => setNoteEdit(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{canvasTexts.noteEdit}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            multiline
            minRows={3}
            value={noteText}
            disabled={!canEdit}
            onChange={(event) => setNoteText(event.target.value)}
            slotProps={{ htmlInput: { 'aria-label': canvasTexts.noteEdit, maxLength: 2000 } }}
          />
        </DialogContent>
        <DialogActions>
          {canEdit && (
            <Button color="error" onClick={() => void removeNote()}>
              {canvasTexts.noteRemove}
            </Button>
          )}
          <Button onClick={() => setNoteEdit(null)}>{canvasTexts.cancel}</Button>
          {canEdit && (
            <Button variant="contained" onClick={() => void saveNote()}>
              {canvasTexts.noteSave}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  )
}
