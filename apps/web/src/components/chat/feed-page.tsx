'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'

import { AppIcon } from '@/components/application/app-icon'
import { PageActionsMenu, useCopyLink } from '@/components/pages/page-actions'
import { pageKindLabels, pageStateLabels, pageTexts } from '@/components/pages/page-labels'
import { useTRPC } from '@/trpc/client'

/**
 * A page the agent published (`feed.page`, docs/plan/69-pages.md, Ст16, Ст23): its title, its one
 * address and the version this row is of; «Открыть», «Скопировать ссылку» and «⋯» — the password,
 * taking it down and putting it back. What the page is now (state, password) comes from
 * `pages.list`: the row says what was, the list what is.
 */
export function FeedPage({
  pageId,
  title,
  version,
  kind,
}: {
  pageId: string
  title: string
  version: number
  kind: 'html' | 'markdown' | 'doc'
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.pages.list.queryOptions())
  const page = list.data?.pages.find((each) => each.pageId === pageId) ?? null
  const { copied, copy } = useCopyLink(page?.url ?? '')
  const live = page?.state === 'live'
  const status = page
    ? [
        pageTexts.version(version),
        page.state === 'taken_down' && page.takenDownBy === 'operator'
          ? pageTexts.byOperator
          : pageStateLabels[page.state].toLowerCase(),
        ...(page.hasPassword ? [pageTexts.withPassword] : []),
      ].join(' · ')
    : pageTexts.version(version)
  return (
    <Box
      component="article"
      aria-label={`${pageKindLabels[kind]} «${title}»`}
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1.5,
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '18px',
        bgcolor: 'background.paper',
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
        <AppIcon name="pages" size={20} />
      </Box>
      <Box sx={{ minWidth: 0, flex: '1 1 220px' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {pageKindLabels[kind]} · {status}
        </Typography>
        <Typography
          sx={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}
        >
          {title}
        </Typography>
        {page && (
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              fontFamily: 'var(--font-jetbrains), monospace',
              overflowWrap: 'anywhere',
            }}
          >
            {page.url}
          </Typography>
        )}
      </Box>
      {page && live && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant="contained"
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={pageTexts.openPage(title)}
            size="small"
            sx={{ minHeight: 40 }}
          >
            {pageTexts.open}
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={() => void copy()}
            sx={{ minHeight: 40 }}
          >
            {copied ? pageTexts.copied : pageTexts.copy}
          </Button>
        </Box>
      )}
      {page && <PageActionsMenu page={page} />}
    </Box>
  )
}
