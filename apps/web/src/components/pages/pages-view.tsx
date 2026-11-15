'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { SectionHeading } from '@/components/application/section-heading'
import { useTRPC } from '@/trpc/client'

import {
  PageActionsMenu,
  PageNoticeBar,
  type PageActionsPage,
  type PageNotice,
} from './page-actions'
import {
  pageKindLabels,
  pageStateLabels,
  pageTagLabels,
  pageTexts,
  trashTexts,
  treeTexts,
  type PageTag,
} from './page-labels'
import { PagesEmpty } from './pages-empty'

const tags: readonly PageTag[] = ['all', 'live', 'pending', 'password', 'taken_down']

type ListedPage = PageActionsPage & {
  kind: 'html' | 'markdown' | 'doc'
  version: number
  treeId: string
  parentId: string | null
  path: string
  position: number
}

/** A row of the list: a page, how deep in its site, and what the row of a site says. */
interface Row {
  page: ListedPage
  depth: number
  /** The pages of its site, for the menu of the page. */
  nodes: readonly ListedPage[]
  /** At a home page with pages below it: how many, and whether they show. */
  site: { pages: number; expanded: boolean } | null
}

const EXPANDED_KEY = 'raditi-pages-expanded'

/** Which sites show their pages: kept for this browser, a convenience that may be closed. */
function useExpanded() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    try {
      const kept = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as unknown
      return new Set(Array.isArray(kept) ? kept.filter((each) => typeof each === 'string') : [])
    } catch {
      return new Set()
    }
  })
  function toggle(treeId: string) {
    const next = new Set(expanded)
    if (next.has(treeId)) next.delete(treeId)
    else next.add(treeId)
    setExpanded(next)
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]))
    } catch {
      // Storage may be closed to the page: the sites just open closed next time.
    }
  }
  return { expanded, toggle }
}

const byPlace = (a: ListedPage, b: ListedPage) =>
  a.position - b.position || a.path.localeCompare(b.path)

/**
 * The rows of the list (docs/plan/73-pages-sites.md, §7.4): a site by its home page, the pages
 * below it with their depth when it is open; a site shows when its home page or any page of it
 * fits the tag and the search. The trash is a flat list of what is in it.
 */
function rowsOf(
  pages: readonly ListedPage[],
  fits: (page: ListedPage) => boolean,
  trash: boolean,
  expanded: ReadonlySet<string>,
): Row[] {
  // The pages of its site come along: «Удалить навсегда» names what goes with a home page.
  if (trash)
    return pages.filter(fits).map((page) => ({
      page,
      depth: 0,
      nodes: pages.filter((other) => other.treeId === page.treeId),
      site: null,
    }))
  const live = pages.filter((page) => page.trash === null)
  const rows: Row[] = []
  for (const home of live.filter((page) => page.parentId === null)) {
    const nodes = live.filter((page) => page.treeId === home.treeId)
    if (!nodes.some(fits)) continue
    const open = expanded.has(home.treeId)
    rows.push({
      page: home,
      depth: 0,
      nodes,
      site: nodes.length > 1 ? { pages: nodes.length, expanded: open } : null,
    })
    if (!open) continue
    const walk = (parentId: string, depth: number) => {
      for (const child of nodes.filter((page) => page.parentId === parentId).sort(byPlace)) {
        rows.push({ page: child, depth, nodes, site: null })
        walk(child.pageId, depth + 1)
      }
    }
    walk(home.pageId, 1)
  }
  return rows
}

/** A page in the trash is under «Корзина» alone; the other tags read the pages outside it. */
const inTag = (page: ListedPage, tag: PageTag): boolean =>
  tag === 'trash'
    ? page.trash !== null
    : page.trash === null &&
      (tag === 'all' || (tag === 'password' ? page.hasPassword : page.state === tag))

/**
 * «Страницы» (docs/plan/69-pages.md, Ст30; docs/plan/73-pages-sites.md, Дер2, Дер6–Дер8): the
 * pages and documents of the user's workspaces — a page belongs to its workspace, not to a chat —
 * filtered by tags over the list, searched by title, each with its address, kind, version and
 * state, and «⋯» for what the client does with it. Before the first page: a word of what will be
 * here instead of filters. «Корзина» shows while something is in it.
 */
export function PagesView({ userId }: { userId: string }) {
  const trpc = useTRPC()
  const list = useQuery(trpc.pages.list.queryOptions())
  const [tag, setTag] = useState<PageTag>('all')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const pages = (list.data?.pages ?? []) as ListedPage[]
  const query = search.trim().toLocaleLowerCase('ru')
  const count = (each: PageTag) => pages.filter((page) => inTag(page, each)).length
  const trashed = count('trash')
  // The trash emptied while it was open: back to all, for good (a later deletion stays there).
  if (tag === 'trash' && trashed === 0 && list.isSuccess) setTag('all')
  const current = tag === 'trash' && trashed === 0 ? 'all' : tag
  const { expanded, toggle } = useExpanded()
  const fits = (page: ListedPage) =>
    inTag(page, current) && page.title.toLocaleLowerCase('ru').includes(query)
  const shown = rowsOf(pages, fits, current === 'trash', expanded)
  // Every page is in the trash and nothing is filtered: say so, not «nothing found».
  const allInTrash = current !== 'trash' && count('all') === 0 && trashed > 0 && query === ''
  const filtered = current !== 'all' || query !== ''
  const empty = list.isSuccess && pages.length === 0
  const shownTags = trashed > 0 ? [...tags, 'trash' as const] : tags

  return (
    // The shell gives the padding, as to «Запланированные задачи» and «Проекты»: the heading
    // stands in one place on the three neighbours of the rail.
    <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto' }}>
      {/* Wraps: on a phone «Новый чат» moves under the title instead of breaking its word. */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1,
          minHeight: 48,
          mb: 2.5,
        }}
      >
        <SectionHeading title={pageTexts.title} about={pageTexts.about} />
        {!empty && list.data?.enabled !== false && (
          <Button
            variant="contained"
            href="/chats/new"
            sx={{ flexShrink: 0, minHeight: 40 }}
            startIcon={<AppIcon name="plus" size={16} />}
          >
            {pageTexts.newChat}
          </Button>
        )}
      </Box>

      {list.data?.enabled === false && <Alert severity="info">{pageTexts.disabled}</Alert>}
      {list.isError && <Alert severity="error">{pageTexts.failed}</Alert>}
      {list.isPending && <Skeleton variant="rounded" height={160} />}
      {list.data?.enabled === true && empty && <PagesEmpty userId={userId} />}

      {list.data?.enabled === true && !empty && (
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
              {shownTags.map((each) => (
                <Button
                  key={each}
                  aria-pressed={current === each}
                  onClick={() => setTag(each)}
                  variant={current === each ? 'contained' : 'outlined'}
                  size="small"
                  startIcon={each === 'trash' ? <AppIcon name="trash" size={14} /> : undefined}
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

          {shown.length === 0 && (
            <Box sx={{ py: 4, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Typography sx={{ color: 'text.secondary' }}>
                {allInTrash ? trashTexts.allInTrash : pageTexts.nothingFound}
              </Typography>
              {allInTrash ? (
                <Button size="small" onClick={() => setTag('trash')}>
                  {trashTexts.openTrash}
                </Button>
              ) : filtered ? (
                <Button
                  size="small"
                  onClick={() => {
                    setTag('all')
                    setSearch('')
                  }}
                >
                  {pageTexts.resetFilters}
                </Button>
              ) : null}
            </Box>
          )}
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {shown.map(({ page, depth, nodes, site }) => (
              <Box
                component="li"
                key={page.pageId}
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 1.5,
                  py: 1.75,
                  pl: { xs: depth * 1.5, sm: depth * 2.5 },
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ minWidth: 0, flex: '1 1 260px', display: 'flex', gap: 1 }}>
                  {site ? (
                    <IconButton
                      size="small"
                      aria-expanded={site.expanded}
                      aria-label={
                        site.expanded
                          ? treeTexts.collapse(page.title)
                          : treeTexts.expand(page.title)
                      }
                      onClick={() => toggle(page.treeId)}
                      sx={{ alignSelf: 'flex-start', mt: '-2px' }}
                    >
                      <Box
                        component="span"
                        sx={{
                          display: 'flex',
                          transform: site.expanded ? 'rotate(90deg)' : 'none',
                          transition: 'transform 150ms ease',
                          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                        }}
                      >
                        <AppIcon name="chevron" size={16} />
                      </Box>
                    </IconButton>
                  ) : depth > 0 ? (
                    <Box aria-hidden sx={{ width: 8, flexShrink: 0 }} />
                  ) : null}
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {page.title}
                      {site ? (
                        <Box
                          component="span"
                          sx={{ ml: 1, fontWeight: 400, color: 'text.secondary', fontSize: 14 }}
                        >
                          {treeTexts.pages(site.pages)}
                        </Box>
                      ) : null}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        color: 'text.secondary',
                        fontFamily: 'var(--font-jetbrains), monospace',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {page.state === 'pending' ? '—' : depth > 0 ? page.path : page.url}
                    </Typography>
                  </Box>
                </Box>
                <Typography
                  variant="body2"
                  sx={{ color: 'text.secondary', flex: '0 0 auto', minWidth: 120 }}
                >
                  {pageKindLabels[page.kind]}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}
                >
                  {page.version > 0 ? pageTexts.version(page.version) : '—'}
                </Typography>
                <Typography variant="body2" sx={{ minWidth: 140, color: 'text.secondary' }}>
                  {page.trash !== null
                    ? trashTexts.purgeOn(page.trash.purgeAfter)
                    : page.state === 'taken_down' && page.takenDownBy === 'operator'
                      ? pageTexts.byOperator
                      : pageStateLabels[page.state]}
                  {page.trash === null && page.hasPassword && depth === 0
                    ? ` · ${pageTexts.withPassword}`
                    : ''}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', ml: 'auto' }}>
                  {page.state === 'live' && page.trash === null && (
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
                  <PageActionsMenu page={page} nodes={nodes} onNotice={setNotice} />
                </Box>
              </Box>
            ))}
          </Box>
        </>
      )}
      <PageNoticeBar notice={notice} onClose={() => setNotice(null)} onNotice={setNotice} />
    </Box>
  )
}
