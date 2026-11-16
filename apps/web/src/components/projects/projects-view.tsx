'use client'

import { projectLimits, type ProjectListSort, type ProjectListView } from '@repo/domain/projects'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import InputAdornment from '@mui/material/InputAdornment'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { ProjectMenuButton, ProjectStarButton, useProjectActions } from './project-actions'
import { ProjectCreateDialog } from './project-create-dialog'
import { projectHref, projectsText, projectUpdatedText } from './project-texts'
import type { ProjectListItem } from './project-types'
import { ProjectsEmpty } from './projects-empty'

const sorts: readonly ProjectListSort[] = ['recent', 'name', 'created']
/** The tabs over the list; «Корзина» stands under it while something is in it (ПР4). */
const tabs = ['all', 'starred', 'archive'] as const satisfies readonly ProjectListView[]

/** The words of the search are in the name or the goal of the project. */
const fits = (project: ProjectListItem, words: string) =>
  words === '' ||
  project.name.toLocaleLowerCase('ru').includes(words) ||
  (project.goal ?? '').toLocaleLowerCase('ru').includes(words)

/**
 * «Проекты» (docs/plan/84-projects.md, ПР4; P-empty, P-list): the heading and «Новый проект», the
 * tabs «Все», «Избранное», «Архив», the order, the search from 7 projects, the cards in a grid of
 * 1, 2 and 3 columns, and «Корзина» under them. Before the first project — P-empty.
 */
export function ProjectsView() {
  const trpc = useTRPC()
  const router = useRouter()
  const [view, setView] = useState<ProjectListView>('all')
  const [sort, setSort] = useState<ProjectListSort>('recent')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState<{
    initial: { name: string; goal: string } | null
  } | null>(null)
  const all = useQuery(trpc.project.list.queryOptions({ view: 'all', sort }))
  const archive = useQuery(trpc.project.list.queryOptions({ view: 'archive', sort }))
  const trash = useQuery(trpc.project.list.queryOptions({ view: 'trash', sort }))
  const lists = { all, archive, trash } as const
  const items = (each: 'all' | 'archive' | 'trash') => lists[each].data?.items ?? []
  const starred = items('all').filter((project) => project.starred)
  const ofView = (each: ProjectListView) => (each === 'starred' ? starred : items(each))
  const count = (each: ProjectListView) => ofView(each).length
  const loaded = all.isSuccess && archive.isSuccess && trash.isSuccess
  const failed = all.isError || archive.isError || trash.isError
  const empty = loaded && count('all') === 0 && count('archive') === 0 && count('trash') === 0
  // The trash emptied while it was open: back to all.
  const current: ProjectListView = view === 'trash' && loaded && count('trash') === 0 ? 'all' : view
  const searching = count('all') + count('archive') >= projectLimits.searchFrom
  const words = searching ? search.trim().toLocaleLowerCase('ru') : ''
  const shown = ofView(current).filter((project) => fits(project, words))

  return (
    <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', px: { xs: 0, md: 2 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 48, mb: 2.5 }}>
        <Typography
          variant="h2"
          component="h1"
          sx={{ flex: '1 1 auto', minWidth: 0, fontSize: { xs: 26, md: 30 }, lineHeight: 1.2 }}
        >
          {projectsText.title}
        </Typography>
        {loaded && !empty ? (
          <Button
            variant="contained"
            aria-haspopup="dialog"
            onClick={() => setCreating({ initial: null })}
            startIcon={<AppIcon name="plus" size={16} />}
            sx={{ flexShrink: 0, minHeight: 44 }}
          >
            {projectsText.newProject}
          </Button>
        ) : null}
      </Box>

      {failed ? <Alert severity="error">{projectsText.failed}</Alert> : null}
      {!loaded && !failed ? (
        <Box
          role="status"
          aria-label={projectsText.loading}
          sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}
        >
          {[0, 1].map((index) => (
            <Skeleton key={index} variant="rounded" height={150} sx={{ borderRadius: '14px' }} />
          ))}
        </Box>
      ) : null}
      {empty ? <ProjectsEmpty onCreate={(initial) => setCreating({ initial })} /> : null}

      {loaded && !empty ? (
        <>
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1.5,
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 2.5,
            }}
          >
            <Box
              role="group"
              aria-label={projectsText.tabsLabel}
              sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
            >
              {tabs.map((each) => (
                <Button
                  key={each}
                  aria-pressed={current === each}
                  onClick={() => setView(each)}
                  variant={current === each ? 'contained' : 'outlined'}
                  size="small"
                  sx={{ borderRadius: 999, minHeight: 36, px: 1.75 }}
                >
                  {projectsText.tabs[each]}
                  <Box
                    component="span"
                    sx={{ ml: 1, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {count(each)}
                  </Box>
                </Button>
              ))}
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
              {searching ? (
                <TextField
                  size="small"
                  placeholder={projectsText.search}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  slotProps={{
                    htmlInput: { 'aria-label': projectsText.search },
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <AppIcon name="search" size={16} />
                        </InputAdornment>
                      ),
                    },
                  }}
                  sx={{ minWidth: { xs: '100%', sm: 240 } }}
                />
              ) : null}
              <SortMenu value={sort} onChange={setSort} />
            </Box>
          </Box>

          {current === 'trash' ? (
            <Typography variant="h3" component="h2" sx={{ fontSize: 18, fontWeight: 600, mb: 2 }}>
              {projectsText.tabs.trash}
            </Typography>
          ) : null}

          {shown.length === 0 ? (
            <Box sx={{ py: 4, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Typography sx={{ color: 'text.secondary' }}>
                {words !== ''
                  ? projectsText.nothingFound
                  : current === 'all'
                    ? projectsText.nothingFound
                    : projectsText.emptyTab[current]}
              </Typography>
              {words !== '' ? (
                <Button size="small" onClick={() => setSearch('')}>
                  {projectsText.resetSearch}
                </Button>
              ) : null}
            </Box>
          ) : (
            <Box
              component="ul"
              aria-label={projectsText.tabs[current]}
              sx={{
                listStyle: 'none',
                m: 0,
                p: 0,
                display: 'grid',
                gap: 2.5,
                gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
              }}
            >
              {shown.map((project) => (
                <li key={project.id}>
                  <ProjectCard
                    project={project}
                    inTrash={current === 'trash'}
                    onNotice={setNotice}
                  />
                </li>
              ))}
            </Box>
          )}

          {count('trash') > 0 || current === 'trash' ? (
            <Box sx={{ mt: 4 }}>
              <Button
                variant={current === 'trash' ? 'contained' : 'outlined'}
                aria-pressed={current === 'trash'}
                size="small"
                onClick={() => setView(current === 'trash' ? 'all' : 'trash')}
                startIcon={<AppIcon name="trash" size={14} />}
                sx={{ borderRadius: 999, minHeight: 36, px: 1.75 }}
              >
                {projectsText.tabs.trash}
                <Box
                  component="span"
                  sx={{ ml: 1, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}
                >
                  {count('trash')}
                </Box>
              </Button>
            </Box>
          ) : null}
        </>
      ) : null}

      <ProjectCreateDialog
        open={creating !== null}
        initial={creating?.initial ?? null}
        onClose={() => setCreating(null)}
        onCreated={(project, then) => {
          setCreating(null)
          // «Подключить GitLab» in the window is an intent: the page opens «Подключить
          // репозиторий» at once, because the sign-in leaves the page (ПР5).
          router.push(
            `${projectHref(project.id)}${then?.connectRepository ? '?connect=repository' : ''}`,
          )
        }}
      />
      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}

function SortMenu({
  value,
  onChange,
}: {
  value: ProjectListSort
  onChange: (sort: ProjectListSort) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const menuId = useId()
  const open = anchor !== null
  return (
    <>
      <Button
        aria-label={`${projectsText.sortLabel}: ${projectsText.sort[value]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        startIcon={<AppIcon name="sort" size={16} />}
        endIcon={<AppIcon name="down" size={14} />}
        sx={{ minHeight: 44, color: 'text.secondary' }}
      >
        {projectsText.sort[value]}
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { borderRadius: '12px', minWidth: 200 } } }}
      >
        {sorts.map((each) => (
          <MenuItem
            key={each}
            role="menuitemradio"
            aria-checked={each === value}
            selected={each === value}
            onClick={() => {
              setAnchor(null)
              onChange(each)
            }}
            sx={{ minHeight: { xs: 44 }, fontSize: 14, gap: 1.5 }}
          >
            {projectsText.sort[each]}
            <Box
              component="span"
              aria-hidden="true"
              sx={{
                ml: 'auto',
                display: 'flex',
                visibility: each === value ? 'visible' : 'hidden',
              }}
            >
              <AppIcon name="check" size={16} />
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

/**
 * A card of the list (P-list): the name, the goal in one line, «N чатов · обновлён …», the star
 * and «⋯». The card opens the project; in «Корзина» it says when it goes for good and «Вернуть».
 */
function ProjectCard({
  project,
  inTrash,
  onNotice,
}: {
  project: ProjectListItem
  inTrash: boolean
  onNotice: (text: string) => void
}) {
  const actions = useProjectActions()
  const titleId = useId()
  const meta = `${projectsText.chats(project.chats)} · ${projectUpdatedText(project.activityAt, new Date())}`
  return (
    <Box
      component="article"
      aria-labelledby={titleId}
      sx={{
        position: 'relative',
        height: '100%',
        minHeight: 150,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: { xs: 2.5, md: 3 },
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.paper',
        transition: 'border-color var(--raditi-motion-fast) var(--raditi-ease-out)',
        '&:hover': inTrash ? undefined : { borderColor: 'text.secondary' },
        '&:focus-within': inTrash ? undefined : { borderColor: 'text.secondary' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ display: 'flex', color: 'text.secondary', pt: '3px' }} aria-hidden>
          <AppIcon name="projects" size={18} />
        </Box>
        <Typography
          id={titleId}
          component="h3"
          sx={{ flex: '1 1 auto', minWidth: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}
        >
          {inTrash ? (
            project.name
          ) : (
            <Box
              component={Link}
              href={projectHref(project.id)}
              sx={{
                color: 'text.primary',
                textDecoration: 'none',
                overflowWrap: 'anywhere',
                // The whole card opens the project; its buttons stand above the link.
                '&::after': { content: '""', position: 'absolute', inset: 0, borderRadius: '14px' },
                '&:focus-visible': { outline: 'none' },
                '&:focus-visible::after': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              {project.name}
            </Box>
          )}
        </Typography>
        <Box sx={{ position: 'relative', zIndex: 1, display: 'flex', mt: -1.25, mr: -1.25 }}>
          {inTrash ? null : (
            <>
              {project.archived ? null : (
                <ProjectStarButton project={project} onNotice={onNotice} />
              )}
              <ProjectMenuButton project={project} onNotice={onNotice} />
            </>
          )}
        </Box>
      </Box>
      {project.goal ? (
        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: 14,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.goal}
        </Typography>
      ) : null}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 'auto', pt: 1 }}>
        {inTrash && project.purgeAfter ? projectsText.purgeOn(project.purgeAfter) : meta}
        {project.archived && !inTrash ? ` · ${projectsText.archivedMark}` : ''}
      </Typography>
      {inTrash ? (
        <Box>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AppIcon name="restore" size={14} />}
            onClick={() =>
              void actions
                .restore(project.id)
                .then((refused) => onNotice(refused ?? projectsText.restored(project.name)))
            }
            aria-label={`${projectsText.restore}: ${project.name}`}
            sx={{ minHeight: 36, borderRadius: 999 }}
          >
            {projectsText.restore}
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
