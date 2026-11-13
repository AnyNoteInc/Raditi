'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import InputAdornment from '@mui/material/InputAdornment'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { PageActionsMenu, type PageActionsPage } from './page-actions'
import {
  pageKindLabels,
  pageStateLabels,
  pageTagLabels,
  pageTexts,
  type PageTag,
} from './page-labels'

const tags: readonly PageTag[] = ['all', 'live', 'pending', 'password', 'taken_down']

type ListedPage = PageActionsPage & {
  kind: 'html' | 'markdown' | 'doc'
  version: number
  chat: { id: string; title: string | null } | null
}

const inTag = (page: ListedPage, tag: PageTag): boolean =>
  tag === 'all' || (tag === 'password' ? page.hasPassword : page.state === tag)

/**
 * «Страницы» (docs/plan/69-pages.md, Ст30; the canvas accepted 13.11.2026): the pages and documents
 * of the user's workspaces, filtered by tags over the list — no panel —, searched by title, each
 * with its address, kind, chat, version and state, and «⋯» for what the client does with it.
 */
export function PagesView() {
  const trpc = useTRPC()
  const list = useQuery(trpc.pages.list.queryOptions())
  const [tag, setTag] = useState<PageTag>('all')
  const [search, setSearch] = useState('')
  const pages = (list.data?.pages ?? []) as ListedPage[]
  const query = search.trim().toLocaleLowerCase('ru')
  const shown = pages.filter(
    (page) => inTag(page, tag) && page.title.toLocaleLowerCase('ru').includes(query),
  )
  const count = (each: PageTag) => pages.filter((page) => inTag(page, each)).length

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 1200,
        mx: 'auto',
        px: { xs: 2, md: 4 },
        py: { xs: 2, md: 3.5 },
      }}
    >
      <Typography component="h1" variant="h4" sx={{ mb: 0.75 }}>
        {pageTexts.title}
      </Typography>
      <Typography sx={{ color: 'text.secondary', mb: 2.5 }}>{pageTexts.lead}</Typography>

      {list.data?.enabled === false && <Alert severity="info">{pageTexts.disabled}</Alert>}
      {list.isError && <Alert severity="error">{pageTexts.failed}</Alert>}

      {list.data?.enabled !== false && (
        <>
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1.5,
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 2,
            }}
          >
            <Box
              role="group"
              aria-label="Показать"
              sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
            >
              {tags.map((each) => (
                <Button
                  key={each}
                  aria-pressed={tag === each}
                  onClick={() => setTag(each)}
                  variant={tag === each ? 'contained' : 'outlined'}
                  size="small"
                  sx={{ borderRadius: 999, minHeight: 36, px: 1.75 }}
                >
                  {pageTagLabels[each]}
                  <Box
                    component="span"
                    sx={{ ml: 1, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {count(each)}
                  </Box>
                </Button>
              ))}
            </Box>
            <TextField
              size="small"
              placeholder={pageTexts.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{
                htmlInput: { 'aria-label': pageTexts.search },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <AppIcon name="search" size={16} />
                    </InputAdornment>
                  ),
                },
              }}
              sx={{ minWidth: { xs: '100%', sm: 260 } }}
            />
          </Box>

          {list.isPending && <Skeleton variant="rounded" height={160} />}
          {list.isSuccess && pages.length === 0 && (
            <Typography sx={{ color: 'text.secondary', py: 4 }}>{pageTexts.empty}</Typography>
          )}
          {list.isSuccess && pages.length > 0 && shown.length === 0 && (
            <Typography sx={{ color: 'text.secondary', py: 4 }}>
              {pageTexts.nothingFound}
            </Typography>
          )}
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {shown.map((page) => (
              <Box
                component="li"
                key={page.pageId}
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 1.5,
                  py: 1.75,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ minWidth: 0, flex: '1 1 260px' }}>
                  <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {page.title}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      color: 'text.secondary',
                      fontFamily: 'var(--font-jetbrains), monospace',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {page.state === 'pending' ? '—' : page.url}
                  </Typography>
                </Box>
                <Typography
                  variant="body2"
                  sx={{ color: 'text.secondary', flex: '0 0 auto', minWidth: 120 }}
                >
                  {pageKindLabels[page.kind]}
                </Typography>
                <Box sx={{ flex: '0 1 200px', minWidth: 0 }}>
                  {page.chat ? (
                    <Link
                      component={NextLink}
                      href={`/chats/${page.chat.id}`}
                      variant="body2"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {page.chat.title ?? pageTexts.chat}
                    </Link>
                  ) : (
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {pageTexts.noChat}
                    </Typography>
                  )}
                </Box>
                <Typography
                  variant="body2"
                  sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}
                >
                  {page.version > 0 ? pageTexts.version(page.version) : '—'}
                </Typography>
                <Typography variant="body2" sx={{ minWidth: 140, color: 'text.secondary' }}>
                  {page.state === 'taken_down' && page.takenDownBy === 'operator'
                    ? pageTexts.byOperator
                    : pageStateLabels[page.state]}
                  {page.hasPassword ? ` · ${pageTexts.withPassword}` : ''}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 'auto' }}>
                  {page.state === 'live' && (
                    <Link
                      href={page.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="body2"
                      aria-label={pageTexts.openPage(page.title)}
                      sx={{ fontWeight: 600 }}
                    >
                      {pageTexts.open}
                    </Link>
                  )}
                  <PageActionsMenu page={page} />
                </Box>
              </Box>
            ))}
          </Box>
        </>
      )}
    </Box>
  )
}
