'use client'

import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { artifactKindSpecOf } from '@repo/domain/artifacts'
import dynamic from 'next/dynamic'

import type { ArtifactBodyProps } from './artifact-body-props'

export type { ArtifactBodyProps } from './artifact-body-props'

// The body of an artifact on its page and in its tab (docs/plan/88-artifacts.md, §7.7, §7.14;
// docs/plan/93-artifacts-trim.md, АТ1): chosen by the view of its kind in the registry (rule 8) —
// Markdown sections or the screens of a canvas.

export const bodyTexts = Object.freeze({
  notShown: 'Этот вид пока не открывается.',
  loading: 'Загружаем…',
})

/** The shape of a body while the code of its kind loads. */
function BodyLoading() {
  return (
    <Box role="status" aria-label={bodyTexts.loading} sx={{ display: 'grid', gap: 1.5 }}>
      <Skeleton variant="rounded" height={32} sx={{ borderRadius: '10px', width: '60%' }} />
      <Skeleton variant="rounded" height={280} sx={{ borderRadius: '14px' }} />
    </Box>
  )
}

// Each kind in its own chunk (docs/plan/96-review-fixes.md, P33.1): a document brings its editor,
// a canvas its frames, and an artifact opens with the code of its kind alone. Of the client only.
const ArtifactDocument = dynamic(
  () => import('./artifact-document').then((module) => module.ArtifactDocument),
  { ssr: false, loading: BodyLoading },
)
const ArtifactCanvas = dynamic(
  () => import('./canvas/artifact-canvas').then((module) => module.ArtifactCanvas),
  { ssr: false, loading: BodyLoading },
)
const ArtifactImages = dynamic(
  () => import('./images/artifact-images').then((module) => module.ArtifactImages),
  { ssr: false, loading: BodyLoading },
)
const ArtifactSlides = dynamic(
  () => import('./slides/artifact-slides').then((module) => module.ArtifactSlides),
  { ssr: false, loading: BodyLoading },
)

export function ArtifactBody(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  // «Презентация» is framed as the canvas is (its frames, thumbnails, `/v/`), shown as slides (88.25).
  if (props.artifact.kind === 'slides') return <ArtifactSlides {...props} />
  // «Изображение» too: pictures in the sizes of their places (88.26).
  if (props.artifact.kind === 'image') return <ArtifactImages {...props} />
  switch (artifactKindSpecOf(props.artifact.kind)?.view) {
    case 'markdown':
      return (
        <ArtifactDocument
          key={props.artifact.id}
          artifact={props.artifact}
          presence={props.presence}
          onChanged={props.onChanged}
          onAccessLost={props.onAccessLost}
          onEditing={props.onEditing}
        />
      )
    case 'canvas':
      return <ArtifactCanvas {...props} />
    default:
      return <Typography sx={{ color: 'text.secondary' }}>{bodyTexts.notShown}</Typography>
  }
}

/** Whether the view of a kind wants the whole width of the page (no outline, no 820 px column). */
export const artifactBodyWide = (kind: string): boolean =>
  artifactKindSpecOf(kind)?.view === 'canvas'
