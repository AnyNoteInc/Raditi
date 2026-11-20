'use client'

import Typography from '@mui/material/Typography'
import { artifactKindSpecOf } from '@repo/domain/artifacts'

import { ArtifactDocument } from './artifact-document'
import { ArtifactBrand } from './brand/artifact-brand'
import { ArtifactCanvas } from './canvas/artifact-canvas'
import { ArtifactMockup } from './mockup/artifact-mockup'
import { ArtifactTable } from './table/artifact-table'
import type { ArtifactBodyProps } from './artifact-body-props'

export type { ArtifactBodyProps } from './artifact-body-props'

// The body of an artifact on its page and in its tab (docs/plan/88-artifacts.md, §7.7, §7.14):
// chosen by the view of its kind in the registry (rule 8) — Markdown sections, a frame, a sheet.

export const bodyTexts = Object.freeze({
  notShown: 'Этот вид пока не открывается.',
})

export function ArtifactBody(props: ArtifactBodyProps) {
  switch (artifactKindSpecOf(props.artifact.kind)?.view) {
    case 'markdown':
      return (
        <ArtifactDocument
          artifact={props.artifact}
          presence={props.presence}
          onChanged={props.onChanged}
          onEditing={props.onEditing}
        />
      )
    case 'frame':
      return <ArtifactMockup {...props} />
    case 'sheet':
      return <ArtifactTable {...props} />
    case 'canvas':
      return <ArtifactCanvas {...props} />
    case 'brand':
      return <ArtifactBrand {...props} />
    default:
      return <Typography sx={{ color: 'text.secondary' }}>{bodyTexts.notShown}</Typography>
  }
}

/** Whether the view of a kind wants the whole width of the page (no outline, no 820 px column). */
export const artifactBodyWide = (kind: string): boolean => {
  const view = artifactKindSpecOf(kind)?.view
  return view === 'frame' || view === 'sheet' || view === 'canvas' || view === 'brand'
}
