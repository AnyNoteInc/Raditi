'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { artifactKindSpecOf } from '@repo/domain/artifacts'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { ArtifactKindIcon } from '@/components/artifacts/artifact-kind-icon'
import { useTRPC } from '@/trpc/client'

/** The words of the card of a canvas, slides or images in the feed: Russian, «вы». */
export const feedArtifactTexts = Object.freeze({
  open: 'Открыть',
  openLabel: (title: string) => `Открыть «${title}»`,
  shownBeside: 'Открыто справа',
})

/**
 * A canvas, slides or images the agent made or changed in a turn (`feed.artifact`, plan 88, Ар46;
 * docs/plan/93-artifacts-trim.md, АТ9): one compact line after the answer — the icon of the kind,
 * the title and «Открыть». «Открыть» shows it in the tab beside the chat (a sheet on a phone);
 * where the chat has no tab, it leads to the page of the artifact. The title comes from the
 * artifacts of the chat; until it is there the kind names it.
 */
export function FeedArtifact({
  taskId,
  artifactId,
  kind,
  onOpen,
  open = false,
}: {
  taskId?: string
  artifactId: string
  kind: string
  onOpen?: (artifactId: string) => void
  /** The tab shows this artifact now: the card says so instead of «Открыть». */
  open?: boolean
}) {
  const trpc = useTRPC()
  const chatArtifacts = useQuery({
    ...trpc.artifact.ofChat.queryOptions({ taskId: taskId ?? '' }),
    enabled: taskId !== undefined,
  })
  const label = artifactKindSpecOf(kind)?.label ?? ''
  const title = chatArtifacts.data?.find((each) => each.id === artifactId)?.title ?? label
  return (
    <Box
      component="article"
      aria-label={`${label} «${title}»`}
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.paper',
        px: 1.75,
        py: 1.25,
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
        <ArtifactKindIcon kind={kind} size={20} />
      </Box>
      <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 15, overflowWrap: 'anywhere' }}>
          {title}
        </Typography>
        {title !== label ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {label}
          </Typography>
        ) : null}
      </Box>
      {open ? (
        <Typography
          variant="body2"
          sx={{ color: 'primary.main', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {feedArtifactTexts.shownBeside}
        </Typography>
      ) : onOpen ? (
        <Button
          size="small"
          variant="outlined"
          onClick={() => onOpen(artifactId)}
          aria-label={feedArtifactTexts.openLabel(title)}
          sx={{ minHeight: 40, flexShrink: 0, borderRadius: '20px' }}
        >
          {feedArtifactTexts.open}
        </Button>
      ) : (
        <Button
          size="small"
          variant="outlined"
          component={NextLink}
          href={`/artifacts/${artifactId}`}
          aria-label={feedArtifactTexts.openLabel(title)}
          sx={{ minHeight: 40, flexShrink: 0, borderRadius: '20px' }}
        >
          {feedArtifactTexts.open}
        </Button>
      )}
    </Box>
  )
}
