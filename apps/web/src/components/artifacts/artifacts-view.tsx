'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import {
  artifactKindSpecOf,
  artifactReleasedKinds,
  artifactTemplates,
  type ArtifactKind,
  type ArtifactTemplate,
} from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'
import Link from 'next/link'
import { useDeferredValue, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { SectionHeading } from '@/components/application/section-heading'
import { useTRPC } from '@/trpc/client'

import { ArtifactCreateDialog } from './artifact-create-dialog'
import { ArtifactKindIcon } from './artifact-kind-icon'
import { emptyTexts, galleryTexts } from './artifact-texts'

type Row = inferRouterOutputs<AppRouter>['artifact']['list'][number]

const filters = ['all', 'mine', 'projects', 'shared', 'trash'] as const
type Filter = (typeof filters)[number]
const sorts = ['newest', 'oldest', 'title'] as const
type Sort = (typeof sorts)[number]
type Layout = 'cards' | 'list'

const LAYOUT_KEY = 'raditi-artifacts-layout'

/** Cards or a list: kept for this browser, a convenience that may be closed. */
function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'cards'
    } catch {
      return 'cards'
    }
  })
  function choose(next: Layout) {
    setLayout(next)
    try {
      localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      // Storage may be closed to the page: cards next time.
    }
  }
  return [layout, choose] as const
}

/**
 * «Артефакты» before the first one (Ар50, board A-empty): what will be here, «Создать», «Попросить
 * агента в чате» and the templates of the kinds that ship.
 */
function ArtifactsEmpty({
  onCreate,
  onTemplate,
}: {
  onCreate: () => void
  onTemplate: (template: ArtifactTemplate) => void
}) {
  const templates = artifactTemplates.filter((each) => artifactReleasedKinds.includes(each.kind))
  return (
    <Box
      component="section"
      aria-labelledby="artifacts-empty-title"
      sx={{
        maxWidth: 640,
        mx: 'auto',
        mt: { xs: 5, md: 8 },
        mb: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 72,
          height: 72,
          borderRadius: '20px',
          display: 'grid',
          placeItems: 'center',
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          color: 'primary.main',
        }}
      >
        <AppIcon name="artifacts" size={34} />
      </Box>
      <Typography
        id="artifacts-empty-title"
        component="h2"
        sx={{ mt: 3, fontSize: { xs: 22, md: 26 }, fontWeight: 600, lineHeight: 1.3 }}
      >
        {emptyTexts.title}
      </Typography>
      <Typography sx={{ mt: 1.25, color: 'text.secondary', fontSize: { xs: 15, md: 16 } }}>
        {emptyTexts.lead}
      </Typography>
      <Box sx={{ mt: 3, display: 'flex', gap: 1.5, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Button
          variant="contained"
          onClick={onCreate}
          startIcon={<AppIcon name="plus" size={16} />}
          sx={{ minHeight: 44, px: 3 }}
        >
          {galleryTexts.create}
        </Button>
        <Button variant="outlined" href="/chats/new" sx={{ minHeight: 44, px: 3 }}>
          {galleryTexts.askAgent}
        </Button>
      </Box>
      <Typography variant="caption" sx={{ mt: 4, mb: 1.25, color: 'text.secondary' }}>
        {emptyTexts.templates}
      </Typography>
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          width: '100%',
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 1.25,
        }}
      >
        {templates.map((template) => (
          <Box component="li" key={template.id}>
            <ButtonBase
              onClick={() => onTemplate(template)}
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                gap: 1.5,
                p: 2,
                textAlign: 'left',
                borderRadius: '12px',
                border: 1,
                borderColor: 'divider',
                bgcolor: 'background.paper',
                '&:hover, &.Mui-focusVisible': { bgcolor: 'action.hover' },
              }}
            >
              <Box sx={{ display: 'flex', color: 'primary.main', pt: '2px' }} aria-hidden>
                <ArtifactKindIcon kind={template.kind} />
              </Box>
              <Box>
                <Typography component="span" sx={{ display: 'block', fontWeight: 600 }}>
                  {template.title}
                </Typography>
                <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>
                  {template.description}
                </Typography>
              </Box>
            </ButtonBase>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function RowActions({
  row,
  trash,
  onTrash,
  onRestore,
}: {
  row: Row
  trash: boolean
  onTrash: () => void
  onRestore: () => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  if (trash)
    return (
      <Button size="small" startIcon={<AppIcon name="restore" size={14} />} onClick={onRestore}>
        {galleryTexts.restore}
      </Button>
    )
  return (
    <>
      <IconButton
        size="small"
        aria-label={galleryTexts.actions(row.title)}
        aria-haspopup="menu"
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <AppIcon name="more" size={18} />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onTrash()
          }}
        >
          {galleryTexts.toTrash}
        </MenuItem>
      </Menu>
    </>
  )
}

/**
 * «Артефакты» (docs/plan/88-artifacts.md, Ар43, Ар50; boards Main, A-empty, A-create): the user's
 * artifacts by the filters «Все», «Мои» (without a project), «В проектах», «Доступные мне» and
 * «Корзина», a kind, a project, an order and a word of the title or text; cards or a list. Before
 * the first one: the empty screen with templates.
 */
export function ArtifactsView({
  userId,
  initialProjectId = '',
}: {
  userId: string
  /** «Все артефакты проекта» of «Контекст» opens the gallery filtered by it (Ар42). */
  initialProjectId?: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const [kind, setKind] = useState<string>('')
  const [projectId, setProjectId] = useState<string>(initialProjectId)
  const [sort, setSort] = useState<Sort>('newest')
  const [layout, setLayout] = useLayout()
  const [creating, setCreating] = useState<{ template: ArtifactTemplate | null } | null>(null)
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null)
  const list = useQuery(
    trpc.artifact.list.queryOptions({
      filter,
      ...(query ? { query } : {}),
      kind: kind === '' ? null : (kind as ArtifactKind),
      projectId: projectId || null,
      sort,
    }),
  )
  // Whether there is anything at all: the empty screen stands in place of the filters.
  const any = useQuery(trpc.artifact.list.queryOptions({ filter: 'all' }))
  const trashed = useQuery(trpc.artifact.list.queryOptions({ filter: 'trash' }))
  const projects = useQuery(trpc.project.list.queryOptions())
  const reread = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.artifact.list.pathKey() })
  const trash = useMutation(trpc.artifact.trash.mutationOptions({ onSuccess: reread }))
  const restore = useMutation(trpc.artifact.restore.mutationOptions({ onSuccess: reread }))
  const rows = list.data ?? []
  const empty =
    any.isSuccess && any.data.length === 0 && trashed.isSuccess && trashed.data.length === 0
  const filtered = filter !== 'all' || query !== '' || kind !== '' || projectId !== ''

  function toTrash(row: Row) {
    void trash.mutateAsync({ artifactId: row.id }).then(() =>
      setNotice({
        text: galleryTexts.trashed(row.title),
        undo: () => void restore.mutateAsync({ artifactId: row.id }),
      }),
    )
  }

  return (
    <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto' }}>
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
        <SectionHeading title={galleryTexts.title} about={galleryTexts.about} />
        {!empty && (
          <Button
            variant="contained"
            onClick={() => setCreating({ template: null })}
            sx={{ flexShrink: 0, minHeight: 40 }}
            startIcon={<AppIcon name="plus" size={16} />}
          >
            {galleryTexts.create}
          </Button>
        )}
      </Box>

      {list.isError && <Alert severity="error">{galleryTexts.failed}</Alert>}
      {(any.isPending || list.isPending) && !list.isError && (
        <Skeleton variant="rounded" height={160} />
      )}
      {empty && (
        <ArtifactsEmpty
          onCreate={() => setCreating({ template: null })}
          onTemplate={(template) => setCreating({ template })}
        />
      )}

      {!empty && any.isSuccess && (
        <>
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1.5,
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 1.5,
            }}
          >
            <Box
              role="group"
              aria-label={galleryTexts.filtersLabel}
              sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
            >
              {filters.map((each) => (
                <Button
                  key={each}
                  aria-pressed={filter === each}
                  onClick={() => setFilter(each)}
                  variant={filter === each ? 'contained' : 'outlined'}
                  size="small"
                  startIcon={each === 'trash' ? <AppIcon name="trash" size={14} /> : undefined}
                  sx={{ borderRadius: 999, minHeight: 36, px: 1.75 }}
                >
                  {galleryTexts.filters[each]}
                </Button>
              ))}
            </Box>
            <TextField
              size="small"
              placeholder={galleryTexts.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{
                htmlInput: { 'aria-label': galleryTexts.search, maxLength: 200 },
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
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2 }}>
            <TextField
              select
              size="small"
              label={galleryTexts.kindLabel}
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              sx={{ minWidth: 150 }}
            >
              <MenuItem value="">{galleryTexts.anyKind}</MenuItem>
              {artifactReleasedKinds.map((each) => (
                <MenuItem key={each} value={each}>
                  {artifactKindSpecOf(each)?.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label={galleryTexts.projectLabel}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">{galleryTexts.anyProject}</MenuItem>
              {(projects.data?.items ?? []).map((project) => (
                <MenuItem key={project.id} value={project.id}>
                  {project.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label={galleryTexts.sortLabel}
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
              sx={{ minWidth: 170 }}
            >
              {sorts.map((each) => (
                <MenuItem key={each} value={each}>
                  {galleryTexts.sorts[each]}
                </MenuItem>
              ))}
            </TextField>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={layout}
              aria-label={galleryTexts.layoutLabel}
              onChange={(_, value: Layout | null) => {
                if (value) setLayout(value)
              }}
              sx={{ ml: { sm: 'auto' } }}
            >
              <ToggleButton value="cards">{galleryTexts.cards}</ToggleButton>
              <ToggleButton value="list">{galleryTexts.list}</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {list.isSuccess && rows.length === 0 && (
            <Box sx={{ py: 4, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Typography sx={{ color: 'text.secondary' }}>
                {filter === 'shared' && query === ''
                  ? galleryTexts.sharedEmpty
                  : filter === 'trash' && query === ''
                    ? galleryTexts.trashEmpty
                    : galleryTexts.nothingFound}
              </Typography>
              {filtered && (
                <Button
                  size="small"
                  onClick={() => {
                    setFilter('all')
                    setSearch('')
                    setKind('')
                    setProjectId('')
                  }}
                >
                  {galleryTexts.resetFilters}
                </Button>
              )}
            </Box>
          )}

          <Box
            component="ul"
            aria-label={galleryTexts.title}
            sx={{
              listStyle: 'none',
              m: 0,
              p: 0,
              ...(layout === 'cards'
                ? {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                    gap: 2,
                  }
                : {}),
            }}
          >
            {rows.map((row) => (
              <GalleryItem
                key={row.id}
                row={row}
                layout={layout}
                trash={filter === 'trash'}
                onTrash={() => toTrash(row)}
                onRestore={() =>
                  void restore
                    .mutateAsync({ artifactId: row.id })
                    .then(() => setNotice({ text: galleryTexts.restored(row.title) }))
                }
              />
            ))}
          </Box>
        </>
      )}

      {creating !== null && (
        <ArtifactCreateDialog
          open
          userId={userId}
          template={creating.template}
          onClose={() => setCreating(null)}
        />
      )}
      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice?.text}
        action={
          notice?.undo ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                notice.undo?.()
                setNotice(null)
              }}
            >
              {galleryTexts.undo}
            </Button>
          ) : undefined
        }
      />
    </Box>
  )
}

function GalleryItem({
  row,
  layout,
  trash,
  onTrash,
  onRestore,
}: {
  row: Row
  layout: Layout
  trash: boolean
  onTrash: () => void
  onRestore: () => void
}) {
  const label = artifactKindSpecOf(row.kind)?.label ?? ''
  const meta = [
    label,
    row.project?.name ?? galleryTexts.personal,
    trash && row.purgeAfter
      ? galleryTexts.purgeOn(row.purgeAfter)
      : galleryTexts.updated(row.updatedAt),
  ].join(' · ')
  const title = (
    <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
      {trash ? (
        row.title
      ) : (
        <Box
          component={Link}
          href={`/artifacts/${row.id}`}
          aria-label={galleryTexts.open(row.title)}
          sx={{
            color: 'inherit',
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' },
            // The whole card answers the link.
            ...(layout === 'cards'
              ? { '&::after': { content: '""', position: 'absolute', inset: 0 } }
              : {}),
          }}
        >
          {row.title}
        </Box>
      )}
    </Typography>
  )
  if (layout === 'list')
    return (
      <Box
        component="li"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
          <ArtifactKindIcon kind={row.kind} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {title}
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {meta}
          </Typography>
        </Box>
        <RowActions row={row} trash={trash} onTrash={onTrash} onRestore={onRestore} />
      </Box>
    )
  return (
    <Box
      component="li"
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '14px',
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        overflow: 'hidden',
        '&:hover': { borderColor: 'text.secondary' },
        '&:focus-within': { outline: '2px solid', outlineColor: 'primary.main' },
      }}
    >
      <Box
        aria-hidden
        sx={{
          height: 120,
          px: 2,
          pt: 1.75,
          bgcolor: 'action.hover',
          color: 'text.secondary',
          fontSize: 12.5,
          lineHeight: 1.5,
          overflow: 'hidden',
          maskImage: 'linear-gradient(to bottom, #000 60%, transparent)',
        }}
      >
        {row.excerpt || galleryTexts.emptyText}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, p: 1.75 }}>
        <Box sx={{ display: 'flex', color: 'primary.main', pt: '2px' }} aria-hidden>
          <ArtifactKindIcon kind={row.kind} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {title}
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {meta}
          </Typography>
        </Box>
        <Box sx={{ position: 'relative', zIndex: 1 }}>
          <RowActions row={row} trash={trash} onTrash={onTrash} onRestore={onRestore} />
        </Box>
      </Box>
    </Box>
  )
}
