'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import {
  artifactKindSpecOf,
  artifactRoleAtLeast,
  type ArtifactElementAnchorInput,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import { ArtifactComments } from '../artifact-comments'
import { EditFrame, type EditFrameHandle, type PickedElement } from './edit-frame'
import { MockupCode } from './mockup-code'
import { MockupFilesButton } from './mockup-files'
import { MockupSettings } from './mockup-settings'
import { mockupTexts } from './mockup-texts'
import { ViewFrame } from './view-frame'

// «Макет» (docs/plan/88-artifacts.md, §7.7, Ар9, Ар28; board C-mockup; slice 88.13): the mockup in
// its frame at the width of a computer, a tablet or a phone; its code to read; «Выбрать элемент» and
// «Править текст» in the edit frame that runs no script; on the right the form «Настройки» of the
// JSON its script reads.

export const mockupDevices = [
  { width: 1440, label: mockupTexts.desktop },
  { width: 768, label: mockupTexts.tablet },
  { width: 390, label: mockupTexts.phone },
] as const

type Mode = 'view' | 'code' | 'select' | 'text'

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

export function ArtifactMockup({
  artifact,
  onChanged,
  onAccessLost,
  place,
  frame: screen,
}: ArtifactBodyProps & {
  /** A screen of a canvas (slice 88.15): its frame, opened by «Открыть»; absent — a mockup. */
  frame?: string
  onAccessLost?: () => void
}) {
  const trpc = useTRPC()
  const [device, setDevice] = useState<number>(place === 'pane' ? 390 : 1440)
  const [mode, setMode] = useState<Mode>('view')
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [editing, setEditing] = useState<{ dirty: boolean } | null>(null)
  const [notice, setNotice] = useState<{
    severity: 'success' | 'error' | 'info'
    text: string
  } | null>(null)
  const [space, setSpace] = useState(0)
  const area = useRef<HTMLDivElement>(null)
  const edit = useRef<EditFrameHandle>(null)
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  // Private notes to an element of the frame (88.18е): the owner's, picked in «Выбрать элемент».
  const canComment =
    artifact.role === 'owner' && artifactKindSpecOf(artifact.kind)?.notes === 'element'
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
      label: mockupTexts.selected(picked.tag, picked.text),
    })
  }
  const frameMode = mode === 'select' || mode === 'text' ? 'edit' : 'view'
  const frame = useQuery({
    // A new revision is a new document of the frame: the address is asked again.
    ...trpc.artifact.frame.queryOptions({
      artifactId: artifact.id,
      mode: frameMode,
      seq: artifact.seq,
      ...(screen === undefined ? {} : { frame: screen }),
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
  const hasHtml = artifact.blocks.some(
    (block) => block.kind === 'html' && block.parent === (screen ?? null),
  )
  const settings =
    artifact.blocks.find((block) => block.kind === 'settings' && block.parent === null) ?? null

  async function done() {
    const end = edit.current?.commit() ?? { kind: 'none' as const }
    setEditing(null)
    if (end.kind === 'none') return
    if (end.kind === 'moved') {
      setNotice({ severity: 'error', text: mockupTexts.editRefused })
      edit.current?.discard()
      return
    }
    const block = end.text.element.slice(0, end.text.element.lastIndexOf('.'))
    const rev = artifact.blocks.find((each) => each.key === block)?.rev
    if (rev === undefined) {
      setNotice({ severity: 'error', text: mockupTexts.editRefused })
      return
    }
    try {
      await editText.mutateAsync({ artifactId: artifact.id, block, ifRev: rev, ...end.text })
      setNotice({ severity: 'success', text: mockupTexts.saved })
      onChanged()
    } catch (error) {
      const code = domainCodeOf(error)
      setNotice({
        severity: 'error',
        text:
          code === 'ARTIFACT_BLOCK_HELD'
            ? mockupTexts.editHeld
            : code === 'ARTIFACT_TEXT_REFUSED' || code === 'ARTIFACT_STALE'
              ? mockupTexts.editRefused
              : code === 'ARTIFACT_SECRET_SHAPE'
                ? mockupTexts.secretShape
                : code === 'PAGE_CONTENT_REFUSED'
                  ? mockupTexts.pageRefused
                  : mockupTexts.editFailed,
      })
      edit.current?.discard()
    }
  }

  const switchMode = (next: Mode | null) => {
    if (next === null || next === mode) return
    if (editing) edit.current?.discard()
    setEditing(null)
    setPicked(null)
    setNotice(null)
    setMode(next)
  }

  const frameTitle =
    frameMode === 'view'
      ? mockupTexts.frameTitle(artifact.title)
      : mockupTexts.editFrameTitle(artifact.title)

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        flexWrap: place === 'pane' ? 'wrap' : 'nowrap',
      }}
    >
      <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={device}
            aria-label={mockupTexts.devices}
            onChange={(_event, value: number | null) => value !== null && setDevice(value)}
          >
            {mockupDevices.map((each) => (
              <ToggleButton
                key={each.width}
                value={each.width}
                aria-label={`${each.label}, ${each.width}`}
              >
                {each.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mode}
            aria-label={mockupTexts.modes}
            onChange={(_event, value: Mode | null) => switchMode(value)}
          >
            <ToggleButton value="view">{mockupTexts.view}</ToggleButton>
            <ToggleButton value="code">{mockupTexts.code}</ToggleButton>
            <ToggleButton value="select" disabled={!hasHtml}>
              {mockupTexts.select}
            </ToggleButton>
            {canEdit && (
              <ToggleButton value="text" disabled={!hasHtml}>
                {mockupTexts.editText}
              </ToggleButton>
            )}
          </ToggleButtonGroup>
          <MockupFilesButton artifact={artifact} canEdit={canEdit} />
        </Box>
        {(mode === 'select' || mode === 'text') && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {mockupTexts.noScripts}.{' '}
              {mode === 'select' ? mockupTexts.selectHint : mockupTexts.editHint}
            </Typography>
            {editing && (
              <>
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => void done()}
                  disabled={editText.isPending}
                >
                  {editText.isPending ? mockupTexts.saving : mockupTexts.done}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    edit.current?.discard()
                    setEditing(null)
                  }}
                >
                  {mockupTexts.discard}
                </Button>
              </>
            )}
          </Box>
        )}
        {picked && mode === 'select' && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <Typography variant="body2" role="status" data-testid="mockup-picked">
              {mockupTexts.selected(picked.tag, picked.text)}
            </Typography>
            {canComment && (
              <Button size="small" variant="outlined" onClick={noteToElement}>
                Заметка к элементу
              </Button>
            )}
          </Box>
        )}
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
            border: 1,
            borderColor: 'divider',
            p: 1,
            bgcolor: 'action.hover',
          }}
        >
          {mode === 'code' ? (
            <MockupCode artifact={artifact} frame={screen ?? null} />
          ) : !hasHtml ? (
            <Typography sx={{ color: 'text.secondary', p: 2 }}>{mockupTexts.empty}</Typography>
          ) : frame.isPending ? (
            <Skeleton variant="rounded" height={480} aria-label={mockupTexts.loading} />
          ) : frame.isError ? (
            <Alert severity="warning">
              {domainCodeOf(frame.error) === 'PAGES_UNAVAILABLE'
                ? mockupTexts.unavailable
                : mockupTexts.frameFailed}
            </Alert>
          ) : frameMode === 'view' ? (
            <ViewFrame
              key={`view-${device}`}
              src={frame.data.url}
              width={device}
              scale={scale}
              title={frameTitle}
            />
          ) : (
            <EditFrame
              key={`edit-${device}-${mode}`}
              ref={edit}
              src={frame.data.url}
              width={device}
              scale={scale}
              title={frameTitle}
              mode={mode === 'text' ? 'text' : 'select'}
              onPick={setPicked}
              onEditing={setEditing}
            />
          )}
        </Box>
      </Box>
      {settings && (
        <Box
          component="aside"
          aria-label={mockupTexts.settings}
          sx={{
            flex: place === 'pane' ? '1 1 100%' : '0 0 300px',
            borderRadius: '12px',
            border: 1,
            borderColor: 'divider',
            p: 2,
          }}
        >
          <MockupSettings
            artifact={artifact}
            block={settings}
            canEdit={canEdit}
            onChanged={onChanged}
          />
        </Box>
      )}
    </Box>
  )
}
