'use client'

import Button, { type ButtonProps } from '@mui/material/Button'
import Tooltip from '@mui/material/Tooltip'
import type { ReactNode } from 'react'

// The head of an artifact, on its page and in its tab beside a chat (docs/plan/93-artifacts-trim.md,
// АТ9): one row of a few actions. The head is a size container: where it is narrow (a phone, a
// narrow tab) the buttons keep their icons and drop their words, which stay their names and
// tooltips.

/** The name of the size container of a head, which its buttons measure. */
export const ARTIFACT_HEAD = 'artifact-head'

/** Narrower than this, the buttons of the head show their icons only. */
const NARROW = '(max-width: 820px)'

/** The rule of a narrow head, for what hides or shrinks in it. */
export const ARTIFACT_HEAD_NARROW = `@container ${ARTIFACT_HEAD} ${NARROW}`

/** The style of the box of a head: one row, a size container. */
export const artifactHeadSx = {
  containerType: 'inline-size',
  containerName: ARTIFACT_HEAD,
} as const

const hidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

/** A button of the head: an icon and a word, the icon alone where the head is narrow. */
export function ArtifactHeadButton({
  icon,
  label,
  sx,
  ...props
}: Omit<ButtonProps, 'children' | 'startIcon'> & { icon: ReactNode; label: string }) {
  return (
    <Tooltip title={label}>
      <Button
        startIcon={icon}
        {...props}
        sx={[
          { flexShrink: 0, whiteSpace: 'nowrap', minHeight: 40 },
          {
            [ARTIFACT_HEAD_NARROW]: {
              minWidth: 40,
              px: 1,
              '& .MuiButton-startIcon': { m: 0 },
              '& .artifact-head-label': hidden,
            },
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        <span className="artifact-head-label">{label}</span>
      </Button>
    </Tooltip>
  )
}
