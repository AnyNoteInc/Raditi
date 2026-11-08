'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Link from '@mui/material/Link'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { projectChip, stackLabels } from './project-labels'
import { ProjectsIllustration } from './projects-illustration'

/** The wizard of a new project is a page of its own (spec §12). */
const NEW_PROJECT = '/projects/new'

/** A list this long is read at a glance: search only above it (К24). */
const SEARCH_ABOVE = 6

/** The order of the list: the server gives the newest first. */
type ProjectsOrder = 'newest' | 'name'
const sortNames: Readonly<Record<ProjectsOrder, string>> = {
  newest: 'Сначала новые',
  name: 'По названию',
}

const iconButtonSx = {
  width: 44,
  height: 44,
  borderRadius: '12px',
  color: 'text.secondary',
  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
} as const

export function ProjectsView() {
  const trpc = useTRPC()
  const projects = useQuery(trpc.project.list.queryOptions())
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [order, setOrder] = useState<ProjectsOrder>('newest')
  const [sortMenu, setSortMenu] = useState<HTMLElement | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const allProjects = projects.data ?? []
  const searchable = allProjects.length > SEARCH_ABOVE
  // A search typed earlier stops filtering with its field: a project deleted in another tab must
  // not leave a list that is narrowed with nothing on the screen to clear it.
  const query = searchable && searchOpen ? search.trim().toLocaleLowerCase('ru') : ''
  const visibleProjects = allProjects
    .filter((project) =>
      `${project.name} ${project.url} ${project.host}`.toLocaleLowerCase('ru').includes(query),
    )
    .sort(order === 'name' ? (a, b) => a.name.localeCompare(b.name, 'ru') : () => 0)
  const projectColumns = {
    xs: 'minmax(0, 1fr)',
    md: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(3, minmax(0, 1fr))',
  }

  function clearSearch() {
    setSearch('')
    searchInput.current?.focus()
  }

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 1200,
        mx: 'auto',
        flex: '1 0 auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 48 }}>
        <Typography
          variant="h2"
          component="h1"
          sx={{ flex: '1 1 auto', minWidth: 0, fontSize: { xs: 26, md: 30 }, lineHeight: 1.2 }}
        >
          Проекты
        </Typography>
        {searchable ? (
          <IconButton
            aria-label="Найти проект"
            aria-pressed={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen)
              if (searchOpen) setSearch('')
            }}
            sx={iconButtonSx}
          >
            <AppIcon name="search" size={20} />
          </IconButton>
        ) : null}
        {allProjects.length > 1 ? (
          <>
            <IconButton
              aria-label="Порядок проектов"
              aria-haspopup="menu"
              aria-expanded={sortMenu !== null}
              onClick={(event) => setSortMenu(event.currentTarget)}
              sx={iconButtonSx}
            >
              <AppIcon name="sort" size={20} />
            </IconButton>
            <Menu
              anchorEl={sortMenu}
              open={sortMenu !== null}
              onClose={() => setSortMenu(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              slotProps={{ paper: { sx: { borderRadius: '14px', minWidth: 200 } } }}
            >
              {(Object.keys(sortNames) as ProjectsOrder[]).map((key) => (
                <MenuItem
                  key={key}
                  role="menuitemradio"
                  aria-checked={order === key}
                  selected={order === key}
                  onClick={() => {
                    setOrder(key)
                    setSortMenu(null)
                  }}
                  sx={{ minHeight: 44, fontSize: 14 }}
                >
                  {sortNames[key]}
                </MenuItem>
              ))}
            </Menu>
          </>
        ) : null}
        <Button variant="contained" href={NEW_PROJECT} sx={{ flexShrink: 0, ml: 1, minHeight: 40 }}>
          Новый проект
        </Button>
      </Box>

      {projects.isPending ? (
        <Box
          role="status"
          aria-label="Загрузка проектов"
          sx={{
            mt: 4,
            display: 'grid',
            gridTemplateColumns: projectColumns,
            gap: 2.5,
          }}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} variant="rounded" height={218} sx={{ borderRadius: '14px' }} />
          ))}
        </Box>
      ) : projects.isError && !projects.data ? (
        <Alert
          severity="error"
          sx={{ mt: 4 }}
          action={
            <Button color="inherit" onClick={() => void projects.refetch()}>
              Повторить
            </Button>
          }
        >
          Не удалось загрузить проекты. Попробуйте ещё раз.
        </Alert>
      ) : allProjects.length === 0 ? (
        <Box
          sx={{
            flex: '1 0 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 1.5,
            py: { xs: 6, md: 8 },
          }}
        >
          <ProjectsIllustration />
          <Typography component="h2" sx={{ mt: 1, fontSize: 17, fontWeight: 600 }}>
            Добавим первый сайт?
          </Typography>
          <Typography
            color="text.secondary"
            sx={{ maxWidth: 430, fontSize: 14, lineHeight: 1.55, textWrap: 'pretty' }}
          >
            Подключите сайт — агент будет готовить правки по вашим просьбам, а на сайт они попадут,
            когда вы их выпустите. Здесь же будут версии, запуски, копии базы и переменные.
          </Typography>
          <Button variant="outlined" color="inherit" href={NEW_PROJECT} sx={{ mt: 1 }}>
            Новый проект
          </Button>
        </Box>
      ) : (
        <>
          <Box
            sx={{
              mt: 4,
              mb: 2.5,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: { xs: 'flex-start', sm: 'center' },
              flexDirection: { xs: 'column', sm: 'row' },
              gap: 2,
              pt: 3,
              borderTop: 1,
              borderColor: 'divider',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25 }}>
              <Typography component="h2" sx={{ fontSize: 16, fontWeight: 600 }}>
                Ваши сайты
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                aria-live="polite"
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {query ? `${visibleProjects.length} из ${allProjects.length}` : allProjects.length}
              </Typography>
            </Box>
            {searchable && searchOpen ? (
              <TextField
                inputRef={searchInput}
                autoFocus
                size="small"
                placeholder="Найти проект"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                slotProps={{
                  htmlInput: { 'aria-label': 'Поиск проектов' },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <AppIcon name="search" size={18} />
                      </InputAdornment>
                    ),
                    endAdornment: search ? (
                      <InputAdornment position="end">
                        <IconButton
                          size="small"
                          aria-label="Очистить поиск"
                          onClick={clearSearch}
                          edge="end"
                          sx={{ width: 44, height: 44 }}
                        >
                          <AppIcon name="close" size={16} />
                        </IconButton>
                      </InputAdornment>
                    ) : undefined,
                  },
                }}
                sx={{ width: { xs: '100%', sm: 280 }, '& .MuiInputBase-root': { minHeight: 48 } }}
              />
            ) : null}
          </Box>
          {visibleProjects.length === 0 ? (
            <Box sx={{ py: 6, px: 1, textAlign: 'center' }}>
              <Box sx={{ color: 'text.secondary', mb: 1.5 }}>
                <AppIcon name="search" size={28} />
              </Box>
              <Typography component="h3" sx={{ fontSize: 18, fontWeight: 600 }}>
                Проекты не найдены
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Попробуйте другое название или адрес сайта.
              </Typography>
              <Button onClick={clearSearch} sx={{ mt: 1 }}>
                Сбросить поиск
              </Button>
            </Box>
          ) : (
            <Box
              component="ul"
              aria-label="Сайты"
              sx={{
                display: 'grid',
                gridTemplateColumns: projectColumns,
                gap: 2.5,
                p: 0,
                m: 0,
                listStyle: 'none',
              }}
            >
              {visibleProjects.map((project) => {
                const chip = projectChip(project)
                return (
                  <Box
                    component="li"
                    key={project.id}
                    sx={{
                      p: { xs: 2.5, sm: 3 },
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: '14px',
                      bgcolor: 'background.paper',
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1.5,
                        mb: 2.5,
                      }}
                    >
                      <AppIcon name="globe" size={24} />
                      <Typography variant="caption" color="text.secondary">
                        {stackLabels[project.stack]}
                      </Typography>
                    </Box>
                    <Typography
                      component="h3"
                      sx={{
                        fontSize: 19,
                        fontWeight: 600,
                        overflowWrap: 'anywhere',
                        lineHeight: 1.35,
                      }}
                    >
                      <Link
                        component={NextLink}
                        href={`/projects/${project.id}`}
                        color="inherit"
                        underline="hover"
                        sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
                      >
                        {project.name}
                      </Link>
                    </Typography>
                    <Link
                      href={project.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      color="text.secondary"
                      aria-label={`Открыть сайт ${project.name} в новой вкладке`}
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.5,
                        maxWidth: '100%',
                        fontSize: 14,
                        mt: 0.75,
                        textUnderlineOffset: '3px',
                      }}
                    >
                      <Box
                        component="span"
                        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {project.host}
                      </Box>
                      <AppIcon name="arrow" size={15} />
                    </Link>
                    <Box sx={{ mt: 'auto', pt: 2.5 }}>
                      <Divider sx={{ mb: 2 }} />
                      <Chip
                        size="small"
                        label={chip.label}
                        variant="outlined"
                        color={chip.color}
                        sx={{
                          maxWidth: '100%',
                          height: 'auto',
                          minHeight: 26,
                          fontSize: 12,
                          '& .MuiChip-label': { py: 0.25, whiteSpace: 'normal' },
                        }}
                      />
                    </Box>
                  </Box>
                )
              })}
            </Box>
          )}
        </>
      )}
    </Box>
  )
}
