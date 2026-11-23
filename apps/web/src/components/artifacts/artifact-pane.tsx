'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { artifactSavedLine } from '@repo/domain/artifacts'
import NextLink from 'next/link'
import { useCallback, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { ArtifactBody } from './artifact-body'
import { ArtifactHistoryButton } from './artifact-history'
import { ArtifactPublishButton } from './artifact-publish'
import { ArtifactPresenceBar, ArtifactTitle } from './artifact-page'
import { documentTexts } from './artifact-texts'
import { useArtifact, type CabinetArtifact } from './use-artifact'

// The tab of one artifact beside the chat (docs/plan/88-artifacts.md, Ар44; board B-chat-doc): its
// head — «Сохранено · версия N», who is here, «История версий», «Во весь экран» — and the artifact
// itself, edited in place as on its page. Nothing loads while the tab is closed (И11): the pane is
// mounted only for an open tab.

export const paneTexts = Object.freeze({
  fullscreen: 'Во весь экран',
  notShown: 'Этот вид пока открывается только в разделе «Артефакты».',
})

export function ArtifactPane({
  artifactId,
  actions,
}: {
  artifactId: string
  /** What the slices of the history and the pages add to the head. */
  actions?: (artifact: CabinetArtifact, reread: () => void) => ReactNode
}) {
  const [block, setBlock] = useState<string | null>(null)
  const { read, accessLost, presence, reread, discardAccess } = useArtifact(artifactId, { block })
  const onEditing = useCallback((key: string | null) => setBlock(key), [])
  const artifact = read.data
  if (read.isPending)
    return (
      <Box sx={{ p: 2 }}>
        <Skeleton variant="rounded" height={200} />
      </Box>
    )
  if (!artifact || accessLost)
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">
          {accessLost ? documentTexts.notFound : documentTexts.loadFailed}
        </Alert>
      </Box>
    )
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1,
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 200px' }}>
          <ArtifactTitle artifact={artifact} onChanged={reread} size="small" />
          {artifact.version > 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {artifactSavedLine(artifact.version)}
            </Typography>
          )}
        </Box>
        <ArtifactPresenceBar presence={presence} />
        <ArtifactHistoryButton artifact={artifact} onChanged={reread} />
        <ArtifactPublishButton artifact={artifact} />
        {actions?.(artifact, reread)}
        <Tooltip title={paneTexts.fullscreen}>
          <IconButton
            component={NextLink}
            href={`/artifacts/${artifact.id}`}
            aria-label={paneTexts.fullscreen}
            sx={{ width: 40, height: 40 }}
          >
            <AppIcon name="fullscreen" size={18} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', px: 2, py: 2 }}>
        <ArtifactBody
          artifact={artifact}
          presence={presence}
          onChanged={reread}
          onAccessLost={discardAccess}
          onEditing={onEditing}
          place="pane"
        />
      </Box>
    </Box>
  )
}
