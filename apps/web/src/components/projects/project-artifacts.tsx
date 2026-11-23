'use client'

import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { ArtifactKindIcon } from '@/components/artifacts/artifact-kind-icon'
import { useTRPC } from '@/trpc/client'

/** The artifacts of a project the group names before «Все артефакты проекта». */
export const PROJECT_ARTIFACT_ROWS = 3

export const projectArtifactsText = Object.freeze({
  title: 'Артефакты проекта',
  empty: 'Здесь появятся документы, макеты и таблицы, которые агент сделает в чатах проекта.',
  all: (count: number) => `Все артефакты проекта (${count})`,
})

/**
 * «Артефакты проекта» inside «Контекст» (docs/plan/88-artifacts.md, Ар42; board F-project): the
 * newest artifacts of the project, each opened at `/artifacts/<id>`, and the gallery filtered by
 * the project. The column keeps its four rows (ПР6): this is a group of «Контекст», not a row.
 */
export function ProjectArtifacts({ projectId }: { projectId: string }) {
  const trpc = useTRPC()
  const list = useQuery(
    trpc.artifact.list.queryOptions({ filter: 'all', projectId, sort: 'newest' }),
  )
  if (list.isPending || list.isError) return null
  const rows = list.data
  return (
    <Box
      component="section"
      aria-label={projectArtifactsText.title}
      sx={{ display: 'grid', gap: 0.75 }}
    >
      <Typography component="h3" sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.secondary' }}>
        {projectArtifactsText.title}
      </Typography>
      {rows.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
          {projectArtifactsText.empty}
        </Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.5 }}>
          {rows.slice(0, PROJECT_ARTIFACT_ROWS).map((artifact) => (
            <Box
              component="li"
              key={artifact.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
            >
              <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
                <ArtifactKindIcon kind={artifact.kind} size={16} />
              </Box>
              <Link
                component={NextLink}
                href={`/artifacts/${artifact.id}`}
                underline="hover"
                color="inherit"
                sx={{
                  fontSize: 14,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {artifact.title}
              </Link>
            </Box>
          ))}
        </Box>
      )}
      {rows.length > PROJECT_ARTIFACT_ROWS ? (
        <Link component={NextLink} href={`/artifacts?project=${projectId}`} sx={{ fontSize: 13 }}>
          {projectArtifactsText.all(rows.length)}
        </Link>
      ) : null}
    </Box>
  )
}
