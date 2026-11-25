'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
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
import { useRouter } from 'next/navigation'
import { useDeferredValue, useEffect, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { SectionHeading } from '@/components/application/section-heading'
import { useTRPC } from '@/trpc/client'

import { ArtifactCreateDialog } from './artifact-create-dialog'
import { ArtifactInvites } from './artifact-invites'
import { ArtifactKindIcon } from './artifact-kind-icon'
import { ArtifactTrashNotice } from './artifact-trash-notice'
import { emptyTexts, galleryTexts } from './artifact-texts'

type Row = inferRouterOutputs<AppRouter>['artifact']['list'][number]

const filters = ['all', 'mine', 'shared', 'trash'] as const
type Filter = (typeof filters)[number]

/** The height of the picture or the text at the top of a card. */
const COVER_HEIGHT = { xs: 120, sm: 140 } as const

/**
 * The templates of the empty screen (docs/plan/93-artifacts-trim.md, АТ9): the first of each kind
 * that ships, at most four.
 */
export function starterTemplates(): ArtifactTemplate[] {
  return artifactReleasedKinds.flatMap((kind) => {
    const first = artifactTemplates.find((each) => each.kind === kind)
    return first ? [first] : []
  })
}

/**
 * «Артефакты» before the first one (АТ9): what will be here, «Создать» and one template of each
 * kind — a template makes the artifact at once and opens it.
 */
function ArtifactsEmpty({
  onCreate,
  onTemplate,
  busy,
}: {
  onCreate: () => void
  onTemplate: (template: ArtifactTemplate) => void
  busy: boolean
}) {
  return (
    <Box
      component="section"
      aria-labelledby="artifacts-empty-title"
      sx={{
        maxWidth: 720,
        mx: 'auto',
        mt: { xs: 4, md: 7 },
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
          width: 64,
          height: 64,
          borderRadius: '18px',
          display: 'grid',
          placeItems: 'center',
          bgcolor: 'action.hover',
          color: 'primary.main',
        }}
      >
        <AppIcon name="artifacts" size={30} />
      </Box>
      <Typography
        id="artifacts-empty-title"
        component="h2"
        sx={{ mt: 2.5, fontSize: { xs: 22, md: 26 }, fontWeight: 600, lineHeight: 1.3 }}
      >
        {emptyTexts.title}
      </Typography>
      <Typography
        sx={{ mt: 1, maxWidth: 520, color: 'text.secondary', fontSize: { xs: 15, md: 16 } }}
      >
        {emptyTexts.lead}
      </Typography>
      <Button
        variant="contained"
        onClick={onCreate}
        startIcon={<AppIcon name="plus" size={16} />}
        sx={{ mt: 3, minHeight: 44, px: 3 }}
      >
        {galleryTexts.create}
      </Button>
      <Typography variant="body2" sx={{ mt: 5, mb: 1.5, color: 'text.secondary' }}>
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
        {starterTemplates().map((template) => (
          <Box component="li" key={template.id}>
            <ButtonBase
              onClick={() => onTemplate(template)}
              disabled={busy}
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                gap: 1.5,
                p: 2,
                textAlign: 'left',
                borderRadius: '14px',
                border: 1,
                borderColor: 'divider',
                bgcolor: 'background.paper',
                '&:hover': { borderColor: 'text.secondary' },
                '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
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

/** «Все · Мои · Доступные мне · Корзина»: one segmented control, a pressed button for each. */
function FilterTabs({
  value,
  onChange,
  sharing,
}: {
  value: Filter
  onChange: (next: Filter) => void
  sharing: boolean
}) {
  const shown = filters.filter((each) => each !== 'shared' || sharing)
  return (
    <Box
      role="group"
      aria-label={galleryTexts.filtersLabel}
      sx={{
        display: 'inline-flex',
        flex: '0 1 auto',
        minWidth: 0,
        overflowX: 'auto',
        scrollbarWidth: 'none',
        p: 0.5,
        gap: 0.25,
        borderRadius: 999,
        bgcolor: 'action.hover',
      }}
    >
      {shown.map((each) => {
        const on = value === each
        return (
          <ButtonBase
            key={each}
            aria-pressed={on}
            onClick={() => onChange(each)}
            sx={{
              flex: 'none',
              minHeight: 32,
              px: 1.5,
              borderRadius: 999,
              fontSize: 14,
              fontWeight: on ? 600 : 500,
              whiteSpace: 'nowrap',
              color: on ? 'text.primary' : 'text.secondary',
              bgcolor: on ? 'background.paper' : 'transparent',
              boxShadow: on ? 1 : 0,
              '&:hover': { color: 'text.primary' },
              '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
            }}
          >
            {galleryTexts.filters[each]}
          </ButtonBase>
        )
      })}
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
      <Tooltip title={galleryTexts.more}>
        <IconButton
          size="small"
          aria-label={galleryTexts.actions(row.title)}
          aria-haspopup="menu"
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <AppIcon name="more" size={18} />
        </IconButton>
      </Tooltip>
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
 * «Артефакты» (docs/plan/88-artifacts.md, Ар50; docs/plan/93-artifacts-trim.md, АТ9): one row of
 * controls — «Все · Мои · Доступные мне · Корзина», a word to find, a kind and «Создать» — then
 * cards, newest first: a picture of the first screen for a canvas, the first slide or the first
 * image; the beginning of the text for a document. «Все артефакты проекта» of a project opens it
 * filtered by the project, which a chip shows and takes off. Before the first one: the empty screen.
 */
export function ArtifactsView({
  userId,
  initialProjectId = '',
  sharing = false,
}: {
  userId: string
  /** «Все артефакты проекта» of «Контекст» opens the gallery filtered by it (Ар42). */
  initialProjectId?: string
  /** «Доступные мне» only where artifacts may be shared (88.16). */
  sharing?: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const [kind, setKind] = useState<string>('')
  const [projectId, setProjectId] = useState<string>(initialProjectId)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null)
  const list = useQuery(
    trpc.artifact.list.queryOptions({
      filter,
      ...(query ? { query } : {}),
      kind: kind === '' ? null : (kind as ArtifactKind),
      projectId: projectId || null,
      sort: 'newest',
    }),
  )
  // Whether there is anything at all: the empty screen stands in place of the filters.
  const any = useQuery(trpc.artifact.list.queryOptions({ filter: 'all' }))
  const trashed = useQuery(trpc.artifact.list.queryOptions({ filter: 'trash' }))
  const projects = useQuery({ ...trpc.project.list.queryOptions(), enabled: projectId !== '' })
  const reread = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.artifact.list.pathKey() })
  const trash = useMutation(trpc.artifact.trash.mutationOptions({ onSuccess: reread }))
  const restore = useMutation(trpc.artifact.restore.mutationOptions({ onSuccess: reread }))
  const create = useMutation(trpc.artifact.create.mutationOptions())
  const rows = list.data ?? []
  const empty =
    any.isSuccess && any.data.length === 0 && trashed.isSuccess && trashed.data.length === 0
  const filtered = filter !== 'all' || query !== '' || kind !== '' || projectId !== ''
  const projectName = projects.data?.items.find((each) => each.id === projectId)?.name ?? null

  function toTrash(row: Row) {
    void trash.mutateAsync({ artifactId: row.id }).then(() =>
      setNotice({
        text: galleryTexts.trashed(row.title),
        undo: () => void restore.mutateAsync({ artifactId: row.id }),
      }),
    )
  }

  /** A template of the empty screen: the artifact is made at once and opens. */
  function fromTemplate(template: ArtifactTemplate) {
    create.mutate(
      {
        kind: template.kind,
        title: template.title,
        projectId: projectId || null,
        templateId: template.id,
      },
      {
        onSuccess: (created) => {
          reread()
          router.push(`/artifacts/${created.id}`)
        },
        onError: () => setNotice({ text: galleryTexts.createFailed }),
      },
    )
  }

  return (
    <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 48, mb: 2 }}>
        <SectionHeading title={galleryTexts.title} about={galleryTexts.about} />
      </Box>

      {/* Invitations to the user's confirmed address (plan 88, Ар35): above everything. */}
      <ArtifactInvites />
      {list.isError && <Alert severity="error">{galleryTexts.failed}</Alert>}
      {(any.isPending || list.isPending) && !list.isError && (
        <Skeleton variant="rounded" height={160} />
      )}
      {empty && (
        <ArtifactsEmpty
          onCreate={() => setCreating(true)}
          onTemplate={fromTemplate}
          busy={create.isPending}
        />
      )}

      {!empty && any.isSuccess && (
        <>
          {/* One row on a computer; two on a phone: the tabs and «Создать», then the search and the kind. */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateAreas: { xs: '"tabs create" "find find"', md: '"tabs find create"' },
              gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', md: 'auto minmax(0, 1fr) auto' },
              alignItems: 'center',
              columnGap: 1.5,
              rowGap: 1.25,
              mb: projectId ? 1.5 : 2.5,
            }}
          >
            <Box sx={{ gridArea: 'tabs', minWidth: 0, display: 'flex' }}>
              <FilterTabs value={filter} onChange={setFilter} sharing={sharing} />
            </Box>
            <Box sx={{ gridArea: 'find', display: 'flex', gap: 1, minWidth: 0 }}>
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
                sx={{ flex: '1 1 auto', minWidth: 0, maxWidth: { md: 320 } }}
              />
              <TextField
                select
                size="small"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                slotProps={{
                  select: {
                    displayEmpty: true,
                    inputProps: { 'aria-label': galleryTexts.kindLabel },
                  },
                }}
                sx={{ flex: 'none', width: { xs: 136, sm: 160 } }}
              >
                <MenuItem value="">{galleryTexts.anyKind}</MenuItem>
                {artifactReleasedKinds.map((each) => (
                  <MenuItem key={each} value={each}>
                    {artifactKindSpecOf(each)?.label}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <Button
              variant="contained"
              onClick={() => setCreating(true)}
              startIcon={<AppIcon name="plus" size={16} />}
              sx={{ gridArea: 'create', justifySelf: 'end', minHeight: 40 }}
            >
              {galleryTexts.create}
            </Button>
          </Box>

          {projectId !== '' && (
            <Box sx={{ mb: 2.5 }}>
              <Tooltip title={galleryTexts.projectReset} describeChild>
                <Chip
                  icon={<AppIcon name="folder" size={14} />}
                  label={galleryTexts.project(projectName ?? '…')}
                  onClick={() => setProjectId('')}
                  onDelete={() => setProjectId('')}
                />
              </Tooltip>
            </Box>
          )}

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
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))',
              gap: 2,
            }}
          >
            {rows.map((row) => (
              <GalleryItem
                key={row.id}
                row={row}
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

      {creating && (
        <ArtifactCreateDialog
          open
          userId={userId}
          projectId={projectId}
          onClose={() => setCreating(false)}
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
      {/* «В корзину» from the page of an artifact: «Вернуть» here (plan 93, АТ9). */}
      <ArtifactTrashNotice />
    </Box>
  )
}

/** Whether an element has come near the screen; without IntersectionObserver — at once. */
function useNearScreen<T extends Element>() {
  const ref = useRef<T | null>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const element = ref.current
    if (near || element === null) return
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((each) => each.isIntersecting)) setNear(true)
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [near])
  return [ref, near] as const
}

/**
 * The picture of a card of a canvas, slides or images: the thumbnail of the first screen, slide or
 * image core draws (§7.7). Asked once the card comes near the screen, again while it is being
 * drawn; until then — the icon of the kind. Never the source of a screen.
 */
function FrameCover({ row }: { row: Row }) {
  const trpc = useTRPC()
  const [ref, near] = useNearScreen<HTMLDivElement>()
  const thumbs = useQuery({
    ...trpc.artifact.canvasThumbs.queryOptions({ artifactId: row.id }),
    enabled: near,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.pending && query.state.data.thumbs[0]?.url == null ? 4000 : false,
  })
  const url = thumbs.data?.thumbs[0]?.url ?? null
  return (
    <Box
      ref={ref}
      aria-hidden
      data-cover="picture"
      sx={{
        height: COVER_HEIGHT,
        bgcolor: 'action.hover',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        color: 'text.disabled',
      }}
    >
      {url ? (
        <Box
          component="img"
          src={url}
          alt=""
          loading="lazy"
          sx={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }}
        />
      ) : (
        <ArtifactKindIcon kind={row.kind} size={32} />
      )}
    </Box>
  )
}

/** The top of a card: a picture for the kinds of screens, the beginning of the text for a document. */
function Cover({ row, trash }: { row: Row; trash: boolean }) {
  const view = artifactKindSpecOf(row.kind)?.view
  // A trashed artifact is not drawn again: the icon of its kind stands there.
  if (view === 'canvas' && !trash) return <FrameCover row={row} />
  const text = view === 'markdown' ? row.excerpt : ''
  return (
    <Box
      aria-hidden
      data-cover="text"
      sx={{
        height: COVER_HEIGHT,
        px: 2,
        pt: 1.75,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        fontSize: 12.5,
        lineHeight: 1.55,
        overflow: 'hidden',
        overflowWrap: 'anywhere',
        maskImage: 'linear-gradient(to bottom, #000 60%, transparent)',
      }}
    >
      {view === 'canvas' ? (
        <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: 'text.disabled' }}>
          <ArtifactKindIcon kind={row.kind} size={32} />
        </Box>
      ) : (
        text || galleryTexts.emptyText
      )}
    </Box>
  )
}

function GalleryItem({
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
  // The icon says the kind: the line says when, and the project if there is one.
  const meta = [
    trash && row.purgeAfter
      ? galleryTexts.purgeOn(row.purgeAfter)
      : galleryTexts.updated(row.updatedAt),
    ...(row.project ? [row.project.name] : []),
  ].join(' · ')
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
        transition: 'border-color 120ms ease',
        '&:hover': { borderColor: 'text.secondary' },
        '&:focus-within': { outline: '2px solid', outlineColor: 'primary.main' },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Cover row={row} trash={trash} />
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, p: 1.5, pl: 1.75 }}>
        <Box sx={{ display: 'flex', color: 'text.secondary', pt: '3px' }} aria-hidden>
          <ArtifactKindIcon kind={row.kind} size={16} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.4 }}>
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
                  '&:focus-visible': { outline: 'none' },
                  // The whole card answers the link.
                  '&::after': { content: '""', position: 'absolute', inset: 0 },
                }}
              >
                {row.title}
              </Box>
            )}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>
            {meta}
          </Typography>
        </Box>
        <Box sx={{ position: 'relative', zIndex: 1, mt: -0.5, mr: -0.5 }}>
          <RowActions row={row} trash={trash} onTrash={onTrash} onRestore={onRestore} />
        </Box>
      </Box>
    </Box>
  )
}
