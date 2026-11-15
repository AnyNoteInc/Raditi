'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import {
  messageOf,
  PageActionsMenu,
  useCopyLink,
  usePageActions,
} from '@/components/pages/page-actions'
import {
  pageKindLabels,
  pageLinkTexts,
  pageStateLabels,
  pageTexts,
  trashTexts,
} from '@/components/pages/page-labels'
import { useTRPC } from '@/trpc/client'

/**
 * A page the agent published (`feed.page`, docs/plan/69-pages.md, Ст16, Ст23): its title, its one
 * address and the version this row is of; «Открыть», «Скопировать ссылку» and «⋯» — the password,
 * taking it down and putting it back. What the page is now (state, password) comes from
 * `pages.list`: the row says what was, the list what is. A page the client deleted says so, with
 * «Вернуть» in «⋯»; one purged since — «Страницы больше нет», with nothing to open
 * (docs/plan/73-pages-sites.md, Дер5).
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
  // A list cached before this page was published does not name it yet: ask once more before
  // saying it is gone.
  const missing = list.isSuccess && list.data.enabled && page === null
  const [asked, setAsked] = useState(false)
  const { refetch } = list
  useEffect(() => {
    if (!missing || asked) return
    void refetch().finally(() => setAsked(true))
  }, [missing, asked, refetch])
  const gone = missing && asked && !list.isFetching
  const { copied, copy } = useCopyLink(page?.url ?? '')
  const live = page?.state === 'live' && page.trash === null
  const status = page
    ? [
        pageTexts.version(version),
        page.trash !== null
          ? trashTexts.inTrash.toLowerCase()
          : page.state === 'taken_down' && page.takenDownBy === 'operator'
            ? pageTexts.byOperator
            : pageStateLabels[page.state].toLowerCase(),
        ...(page.trash === null && page.hasPassword ? [pageTexts.withPassword] : []),
      ].join(' · ')
    : gone
      ? `${pageTexts.version(version)} · ${trashTexts.gone.toLowerCase()}`
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
        {page && page.trash === null && (
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
      {page && (
        <PageActionsMenu
          page={page}
          purge={false}
          // Its site, as «Страницы» has it: a home page is deleted as a site, a page moves among them.
          nodes={list.data?.pages.filter((each) => each.treeId === page.treeId) ?? []}
        />
      )}
    </Box>
  )
}

/**
 * What the agent did to a page at the end of its turn (`feed.page_change`,
 * docs/plan/73-pages-sites.md, Дер27): «Агент перенёс в корзину …», with «Вернуть» while the page
 * is still in the trash and the client may return it — the confirmation after the fact the rule
 * of dangerous changes asks for until `request_approval` exists (В2).
 */
export function FeedPageChange({
  pageId,
  text,
  change,
}: {
  pageId: string
  text: string
  change: 'trashed' | 'restored' | 'updated'
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.pages.list.queryOptions())
  const { returnDeleted } = usePageActions()
  const [refused, setRefused] = useState<string | null>(null)
  const page = list.data?.pages.find((each) => each.pageId === pageId) ?? null
  const offer = change === 'trashed' && page !== null && page.trash !== null && page.canManage
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1.5,
        color: 'text.secondary',
      }}
    >
      <Box sx={{ display: 'flex' }} aria-hidden>
        <AppIcon name={change === 'trashed' ? 'trash' : 'pages'} size={16} />
      </Box>
      <Typography variant="body2" sx={{ flex: '1 1 240px', overflowWrap: 'anywhere' }}>
        {text}
      </Typography>
      {offer && (
        <Button
          size="small"
          variant="outlined"
          disabled={returnDeleted.isPending}
          onClick={() => {
            setRefused(null)
            returnDeleted.mutate({ pageId }, { onError: (error) => setRefused(messageOf(error)) })
          }}
        >
          {trashTexts.returnBack}
        </Button>
      )}
      {refused !== null && (
        <Typography variant="body2" role="alert" sx={{ color: 'error.main', flexBasis: '100%' }}>
          {refused}
        </Typography>
      )}
    </Box>
  )
}

/** Links of a version to its site that lead nowhere (Дер20): a word below its card. */
export function FeedPageWarnings({
  warnings,
}: {
  warnings: readonly { href: string; problem: 'missing' | 'relative' }[]
}) {
  if (warnings.length === 0) return null
  const missing = warnings.filter((each) => each.problem === 'missing').map((each) => each.href)
  const relative = warnings.filter((each) => each.problem === 'relative').map((each) => each.href)
  return (
    <Typography variant="body2" sx={{ color: 'warning.main', overflowWrap: 'anywhere' }}>
      {missing.length > 0 && `${pageLinkTexts.missing} ${missing.join(', ')}. `}
      {relative.length > 0 && `${pageLinkTexts.relative} ${relative.join(', ')}. `}
      {pageLinkTexts.ask}
    </Typography>
  )
}
