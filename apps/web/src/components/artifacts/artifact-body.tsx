'use client'

import Typography from '@mui/material/Typography'
import { artifactKindSpecOf } from '@repo/domain/artifacts'

import { ArtifactDocument } from './artifact-document'
import { ArtifactCanvas } from './canvas/artifact-canvas'
import { ArtifactImages } from './images/artifact-images'
import { ArtifactSlides } from './slides/artifact-slides'
import type { ArtifactBodyProps } from './artifact-body-props'

export type { ArtifactBodyProps } from './artifact-body-props'

// The body of an artifact on its page and in its tab (docs/plan/88-artifacts.md, §7.7, §7.14;
// docs/plan/93-artifacts-trim.md, АТ1): chosen by the view of its kind in the registry (rule 8) —
// Markdown sections or the screens of a canvas.

export const bodyTexts = Object.freeze({
  notShown: 'Этот вид пока не открывается.',
})

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
