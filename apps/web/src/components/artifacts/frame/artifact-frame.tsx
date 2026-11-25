'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import {
  artifactKindSpecOf,
  artifactRoleAtLeast,
  artifactSettingsFields,
  type ArtifactElementAnchorInput,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import {
  ArtifactComments,
  ArtifactSharingAvailable,
  artifactNotesWritable,
} from '../artifact-comments'
import { EditFrame, type EditFrameHandle, type PickedElement } from './edit-frame'
import { FrameCode } from './frame-code'
import { FrameFilesDialog } from './frame-files'
import { FrameSettings } from './frame-settings'
import { frameTexts } from './frame-texts'
import { ViewFrame } from './view-frame'

// One screen of a canvas, a slide or a picture (docs/plan/93-artifacts-trim.md, АТ6, АТ7;
// docs/plan/88-artifacts.md, §7.7, Ар9, Ар28): the frame block at the width of a computer or a
// phone. One light toolbar — the device (only for an adaptive screen), «Править текст», and «⋯»
// with «Показать код», «Выбрать элемент для заметки» and «Файлы»; a hint row only while a mode is
// on; on the right the folding form «Настройки» of the JSON its script reads. A host with its own
// controls (a slide, a picture) shows it bare and opens it in «Править текст» itself.

export const frameDevices = [
  { width: 1440, label: frameTexts.desktop },
  { width: 390, label: frameTexts.phone },
] as const

type Mode = 'view' | 'code' | 'select' | 'text'

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

export interface ArtifactFrameProps extends ArtifactBodyProps {
  /** The key of the frame block shown: a screen of a canvas, a slide or a picture. */
  frame: string
  /** A slide of «Презентация» (88.25) or a picture: one view of a fixed size, no choice of a device. */
  slide?: { width: number; height: number }
  /**
   * Without a toolbar of its own, on a stage without a border: the view around it carries its own
   * controls (a slide of «Презентация», a picture; plan 93, АТ7, АТ8). Hint rows stay while a mode
   * is on.
   */
  bare?: boolean
  /** The mode it opens in; a host with its own «Править текст» changes it by a new key. */
  startMode?: 'view' | 'text'
  /** The viewer entered or left «Править текст» itself (another mode, «Закончить правку»). */
  onTextEditingChange?: (on: boolean) => void
  /** The host's controls at the start of the toolbar (a canvas: «Все экраны»). */
  leading?: ReactNode
  /** The host's controls before «⋯» (a canvas: «Добавить экран»). */
  trailing?: ReactNode
  onAccessLost?: () => void
}

export function ArtifactFrame({
  artifact,
  onChanged,
  onAccessLost,
  place,
  frame: screen,
  slide,
  bare = false,
  startMode = 'view',
  onTextEditingChange,
  leading,
  trailing,
}: ArtifactFrameProps) {
  const trpc = useTRPC()
  const menuId = useId()
  const [device, setDevice] = useState<number>(slide ? slide.width : place === 'pane' ? 390 : 1440)
  const [mode, setMode] = useState<Mode>(startMode)
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [editing, setEditing] = useState<{ dirty: boolean } | null>(null)
  const [notice, setNotice] = useState<{
    severity: 'success' | 'error' | 'info'
    text: string
  } | null>(null)
  const [space, setSpace] = useState(0)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const edit = useRef<EditFrameHandle>(null)
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  // Private notes to an element of the frame (88.18е): the owner's, picked from «⋯».
  const sharing = useContext(ArtifactSharingAvailable)
  const canComment =
    (artifact.role === 'owner' || sharing) && artifactKindSpecOf(artifact.kind)?.notes === 'element'
  const writable = canComment && artifactNotesWritable(artifact.role, sharing)
  const [commentDraft, setCommentDraft] = useState<{
    anchor: ArtifactElementAnchorInput
    label: string
  } | null>(null)
  const noteToElement = () => {
    if (!picked) return
    const block = picked.element.slice(0, picked.element.lastIndexOf('.'))
    const rev = artifact.blocks.find((each) => each.key === block && each.kind === 'html')?.rev
    if (rev === undefined) return
    setCommentDraft({
      anchor: { kind: 'element', block, element: picked.element, rev },
      label: frameTexts.selected(picked.text),
    })
  }
  const frameMode = mode === 'select' || mode === 'text' ? 'edit' : 'view'
  const frame = useQuery({
    // A new revision is a new document of the frame: the address is asked again.
    ...trpc.artifact.frame.queryOptions({
      artifactId: artifact.id,
      mode: frameMode,
      seq: artifact.seq,
      frame: screen,
    }),
    enabled: mode !== 'code',
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
  })
  const editText = useMutation(trpc.artifact.editText.mutationOptions())

  useEffect(() => {
    const element = area.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setSpace(entry?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const scale = space > 0 ? Math.min(1, space / device) : 1
  const hasHtml = artifact.blocks.some((block) => block.kind === 'html' && block.parent === screen)
  const settings =
    artifact.blocks.find((block) => block.kind === 'settings' && block.parent === null) ?? null
  const settingsFields = useMemo(
    () => (settings ? (artifactSettingsFields(settings.content ?? '{}') ?? []) : []),
    [settings],
  )
  // Open at first when there is something to change: a calculator shows its prices beside it.
  const [settingsOpen, setSettingsOpen] = useState(settingsFields.length > 0)

  async function done() {
    const end = edit.current?.commit() ?? { kind: 'none' as const }
    setEditing(null)
    if (end.kind === 'none') return
    if (end.kind === 'moved') {
      setNotice({ severity: 'error', text: frameTexts.editRefused })
      edit.current?.discard()
      return
    }
    const block = end.text.element.slice(0, end.text.element.lastIndexOf('.'))
    const rev = artifact.blocks.find((each) => each.key === block)?.rev
    if (rev === undefined) {
      setNotice({ severity: 'error', text: frameTexts.editRefused })
      return
    }
    try {
      await editText.mutateAsync({ artifactId: artifact.id, block, ifRev: rev, ...end.text })
      setNotice({ severity: 'success', text: frameTexts.saved })
      onChanged()
    } catch (error) {
      const code = domainCodeOf(error)
      setNotice({
        severity: 'error',
        text:
          code === 'ARTIFACT_BLOCK_HELD'
            ? frameTexts.editHeld
            : code === 'ARTIFACT_TEXT_REFUSED' || code === 'ARTIFACT_STALE'
              ? frameTexts.editRefused
              : code === 'ARTIFACT_SECRET_SHAPE'
                ? frameTexts.secretShape
                : code === 'PAGE_CONTENT_REFUSED'
                  ? frameTexts.pageRefused
                  : frameTexts.editFailed,
      })
      edit.current?.discard()
    }
  }

  const switchMode = (next: Mode) => {
    setMenu(null)
    if (next === mode) return
    if (editing) edit.current?.discard()
    setEditing(null)
    setPicked(null)
    setNotice(null)
    setMode(next)
    if ((next === 'text') !== (mode === 'text')) onTextEditingChange?.(next === 'text')
  }

  const frameTitle =
    frameMode === 'view'
      ? frameTexts.frameTitle(artifact.title)
      : frameTexts.editFrameTitle(artifact.title)

  const bar = !bare && (
    <Box
      role="toolbar"
      aria-label={frameTexts.toolbar}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}
    >
      {leading}
      {!slide && (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={device}
          aria-label={frameTexts.devices}
          onChange={(_event, value: number | null) => value !== null && setDevice(value)}
        >
          {frameDevices.map((each) => (
            <ToggleButton
              key={each.width}
              value={each.width}
              aria-label={`${each.label}, ${each.width}`}
              sx={{ px: 1.5 }}
            >
              {each.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
      {canEdit && hasHtml && (
        <ToggleButton
          size="small"
          value="text"
          selected={mode === 'text'}
          onChange={() => switchMode(mode === 'text' ? 'view' : 'text')}
          sx={{ px: 1.5, gap: 0.75 }}
        >
          <AppIcon name="pencil" size={16} />
          {frameTexts.editText}
        </ToggleButton>
      )}
      <Box sx={{ flex: 1 }} />
      {settings && (
        <Tooltip
          describeChild
          title={settingsOpen ? frameTexts.settingsHide : frameTexts.settingsShow}
        >
          <ToggleButton
            size="small"
            value="settings"
            selected={settingsOpen}
            onChange={() => setSettingsOpen(!settingsOpen)}
            sx={{ px: 1.5, gap: 0.75 }}
          >
            <AppIcon name="settings" size={16} />
            {frameTexts.settings}
          </ToggleButton>
        </Tooltip>
      )}
      {trailing}
      <Tooltip title={frameTexts.more}>
        <IconButton
          size="small"
          aria-label={frameTexts.more}
          aria-haspopup="menu"
          aria-controls={menu ? menuId : undefined}
          aria-expanded={menu ? 'true' : undefined}
          onClick={(event) => setMenu(event.currentTarget)}
        >
          <AppIcon name="more" size={18} />
        </IconButton>
      </Tooltip>
      <Menu id={menuId} anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => switchMode(mode === 'code' ? 'view' : 'code')}>
          {mode === 'code' ? frameTexts.hideCode : frameTexts.showCode}
        </MenuItem>
        {canComment && hasHtml && (
          <MenuItem onClick={() => switchMode('select')}>{frameTexts.pick}</MenuItem>
        )}
        <MenuItem
          onClick={() => {
            setMenu(null)
            setFilesOpen(true)
          }}
        >
          {frameTexts.files}
        </MenuItem>
      </Menu>
    </Box>
  )

  // The hint row: only while a mode is on, with the way out of it.
  const hint = mode !== 'view' && (
    <Box
      data-testid="frame-hint"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        alignItems: 'center',
        px: 1.5,
        py: 1,
        borderRadius: '10px',
        bgcolor: 'action.hover',
      }}
    >
      <Typography
        variant="body2"
        role="status"
        {...(mode === 'select' && picked ? { 'data-testid': 'frame-picked' } : {})}
        sx={{ color: 'text.secondary', flex: '1 1 240px' }}
      >
        {mode === 'text'
          ? frameTexts.editHint
          : mode === 'select'
            ? picked
              ? frameTexts.selected(picked.text)
              : frameTexts.selectHint
            : frameTexts.codeReadOnly}
      </Typography>
      {mode === 'text' && editing && (
        <>
          <Button
            size="small"
            variant="contained"
            onClick={() => void done()}
            disabled={editText.isPending}
          >
            {editText.isPending ? frameTexts.saving : frameTexts.done}
          </Button>
          <Button
            size="small"
            onClick={() => {
              edit.current?.discard()
              setEditing(null)
            }}
          >
            {frameTexts.discard}
          </Button>
        </>
      )}
      {mode === 'text' && !editing && bare && onTextEditingChange && (
        <Button size="small" onClick={() => switchMode('view')}>
          {frameTexts.endEdit}
        </Button>
      )}
      {mode === 'select' && picked && writable && (
        <Button size="small" variant="contained" onClick={noteToElement}>
          {frameTexts.noteToElement}
        </Button>
      )}
      {mode === 'select' && (
        <Button size="small" onClick={() => switchMode('view')}>
          {frameTexts.closeMode}
        </Button>
      )}
      {mode === 'code' && (
        <Button size="small" onClick={() => switchMode('view')}>
          {frameTexts.backToScreen}
        </Button>
      )}
    </Box>
  )

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        flexWrap: place === 'pane' ? 'wrap' : { xs: 'wrap', md: 'nowrap' },
      }}
    >
      <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {bar}
        {hint}
        {canComment && (
          <ArtifactComments
            key={artifact.id}
            artifact={artifact}
            draft={commentDraft?.anchor ?? null}
            draftLabel={commentDraft?.label}
            onClose={() => setCommentDraft(null)}
            onChanged={onChanged}
            onAccessLost={onAccessLost ?? (() => {})}
          />
        )}
        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}
        <Box
          ref={area}
          sx={{
            minWidth: 0,
            borderRadius: '12px',
            p: bare ? { xs: 1, md: 3 } : { xs: 0.5, sm: 1 },
            bgcolor: 'action.hover',
          }}
        >
          {mode === 'code' ? (
            <FrameCode artifact={artifact} frame={screen} />
          ) : !hasHtml ? (
            <Typography sx={{ color: 'text.secondary', p: 2 }}>{frameTexts.empty}</Typography>
          ) : frame.isPending ? (
            <Skeleton variant="rounded" height={480} aria-label={frameTexts.loading} />
          ) : frame.isError ? (
            <Alert severity="warning">
              {domainCodeOf(frame.error) === 'PAGES_UNAVAILABLE'
                ? frameTexts.unavailable
                : frameTexts.frameFailed}
            </Alert>
          ) : frameMode === 'view' ? (
            <ViewFrame
              key={`view-${device}`}
              src={frame.data.url}
              width={device}
              scale={scale}
              title={frameTitle}
              {...(slide ? { fixedHeight: slide.height } : {})}
            />
          ) : (
            <EditFrame
              key={`edit-${device}-${mode}`}
              ref={edit}
              src={frame.data.url}
              width={device}
              scale={scale}
              title={frameTitle}
              {...(slide ? { fixedHeight: slide.height } : {})}
              mode={mode === 'text' ? 'text' : 'select'}
              onPick={setPicked}
              onEditing={setEditing}
            />
          )}
        </Box>
      </Box>
      {settings && settingsOpen && (
        <Box
          component="aside"
          aria-label={frameTexts.settings}
          sx={{
            flex: place === 'pane' ? '1 1 100%' : { xs: '1 1 100%', md: '0 0 300px' },
            borderRadius: '12px',
            border: 1,
            borderColor: 'divider',
            p: 2,
          }}
        >
          <FrameSettings
            artifact={artifact}
            block={settings}
            canEdit={canEdit}
            onChanged={onChanged}
          />
        </Box>
      )}
      <FrameFilesDialog
        artifact={artifact}
        canEdit={canEdit}
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
      />
    </Box>
  )
}
