'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { projectChip, stackLabels } from './project-labels'

/** The wizard of a new project is a page of its own (spec §12). */
const NEW_PROJECT = '/projects/new'

export function ProjectsView() {
  const trpc = useTRPC()
  const projects = useQuery(trpc.project.list.queryOptions())
  const [search, setSearch] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const allProjects = projects.data ?? []
  const query = search.trim().toLocaleLowerCase('ru')
  const visibleProjects = allProjects.filter((project) =>
    `${project.name} ${project.url} ${project.host}`.toLocaleLowerCase('ru').includes(query),
  )
  const showHeaderAction = allProjects.length > 0 || (projects.isError && !projects.data)
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
    <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: { xs: 'flex-start', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 2.5,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="h1"
            sx={{
              fontSize: { xs: 28, md: 32 },
              fontWeight: 600,
              letterSpacing: '-0.025em',
              lineHeight: 1.25,
            }}
          >
            Проекты
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1, textWrap: 'pretty' }}>
            Все ваши сайты в одном месте.
          </Typography>
        </Box>
        {showHeaderAction && (
          <Button
            variant="contained"
            href={NEW_PROJECT}
            startIcon={<AppIcon name="plus" size={18} />}
            sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
          >
            Добавить проект
          </Button>
        )}
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
            mt: 4,
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
            bgcolor: 'background.default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            px: { xs: 2, sm: 4 },
            py: { xs: 5, sm: 7 },
          }}
        >
          <Box sx={{ maxWidth: 400, minWidth: 0 }}>
            <Box sx={{ color: 'primary.main', mb: 2.5 }}>
              <AppIcon name="globe" size={36} />
            </Box>
            <Typography
              component="h2"
              sx={{
                fontSize: { xs: 22, sm: 24 },
                fontWeight: 600,
                lineHeight: 1.3,
                letterSpacing: '-0.02em',
                textWrap: 'balance',
              }}
            >
              Здесь будут ваши сайты
            </Typography>
            <Typography
              color="text.secondary"
              sx={{ mt: 1.5, mb: 3, lineHeight: 1.6, textWrap: 'pretty' }}
            >
              Добавьте первый сайт: укажите его адрес и доступ к файлам, а мы сохраним его
              первоначальную версию.
            </Typography>
            <Button
              variant="contained"
              href={NEW_PROJECT}
              startIcon={<AppIcon name="plus" size={18} />}
              sx={{ width: { xs: '100%', sm: 'auto' } }}
            >
              Добавить проект
            </Button>
          </Box>
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
            <TextField
              inputRef={searchInput}
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
