'use client'

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import dynamic from 'next/dynamic'

import { dialogText } from './chat-texts'

// What a chat shows only sometimes comes in its own chunk, loaded as it is first opened
// (docs/plan/96-review-fixes.md, P33.1): the tabs of its tools — an artifact, the browser, a
// document — and the windows of a scheduled task, of a move into a project and of a publication.
// All of them are of the client only: the server renders none of them in the first paint.

/** What a tab of a tool shows while its code loads: the shape of a pane, nothing that moves. */
export function PaneLoading() {
  return (
    <Box role="status" aria-label={dialogText.loading} sx={{ display: 'grid', gap: 1.5, p: 2 }}>
      <Skeleton variant="rounded" height={40} sx={{ borderRadius: '10px' }} />
      <Skeleton variant="rounded" height={240} sx={{ borderRadius: '14px' }} />
    </Box>
  )
}

export const ArtifactPane = dynamic(
  () => import('@/components/artifacts/artifact-pane').then((module) => module.ArtifactPane),
  { ssr: false, loading: PaneLoading },
)

export const BrowserPane = dynamic(
  () => import('./browser-pane').then((module) => module.BrowserPane),
  { ssr: false, loading: PaneLoading },
)

export const DocumentsPane = dynamic(
  () => import('./documents-pane').then((module) => module.DocumentsPane),
  { ssr: false, loading: PaneLoading },
)

// The windows: nothing while their code loads — they open a moment later.

export const ScheduleDialog = dynamic(
  () => import('@/components/scheduled/schedule-dialog').then((module) => module.ScheduleDialog),
  { ssr: false },
)

export const MoveToProjectDialog = dynamic(
  () =>
    import('@/components/projects/move-to-project').then((module) => module.MoveToProjectDialog),
  { ssr: false },
)

export const PublishTargetDialog = dynamic(
  () => import('./publish-target-dialog').then((module) => module.PublishTargetDialog),
  { ssr: false },
)
