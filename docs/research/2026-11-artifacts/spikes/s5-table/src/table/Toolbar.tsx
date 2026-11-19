import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import { DownloadIcon, FilterIcon, RefreshIcon, SearchIcon, SortIcon } from './icons'
import { CATEGORIES } from './model'
import type { Filters, Sorting, Stock } from './view'

export interface ToolbarProps {
  narrow: boolean
  title: string
  count: number
  total: number
  stale: boolean
  filters: Filters
  sorting: Sorting
  onRefresh(t0: number): void
  onFilters(next: Filters, t0: number): void
  onSorting(next: Sorting, t0: number): void
  onDownload(kind: 'csv' | 'xlsx'): void
}

const SORTS: Array<{ label: string; sorting: Sorting }> = [
  { label: 'Без сортировки', sorting: [] },
  { label: 'Название: А → Я', sorting: [{ id: 'name', desc: false }] },
  { label: 'Название: Я → А', sorting: [{ id: 'name', desc: true }] },
  { label: 'Цена: сначала дешёвые', sorting: [{ id: 'price', desc: false }] },
  { label: 'Цена: сначала дорогие', sorting: [{ id: 'price', desc: true }] },
  { label: 'Категория, затем цена', sorting: [{ id: 'category', desc: false }, { id: 'price', desc: false }] },
]

const STOCKS: Array<{ value: Stock; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'yes', label: 'Есть в наличии' },
  { value: 'no', label: 'Нет в наличии' },
]

function same(a: Sorting, b: Sorting): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i]?.id && s.desc === b[i]?.desc)
}

export function Toolbar(props: ToolbarProps) {
  const { narrow, title, count, total, stale, filters, sorting } = props
  const [menu, setMenu] = useState<{ kind: 'filter' | 'sort' | 'download'; anchor: HTMLElement } | null>(null)
  const filtered = filters.categories.length > 0 || filters.stock !== 'all'
  const close = () => setMenu(null)
  const counter = count === total ? `${total.toLocaleString('ru-RU')} строк` : `${count.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')}`

  const search = (
    <TextField
      size="small"
      placeholder="Поиск по таблице"
      value={filters.search}
      onChange={(e) => props.onFilters({ ...filters, search: e.target.value }, e.timeStamp)}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        },
        htmlInput: { 'aria-label': 'Поиск по таблице', enterKeyHint: 'search', 'data-search': '' },
      }}
      sx={{ width: narrow ? '100%' : 280 }}
    />
  )

  const button = (kind: 'filter' | 'sort' | 'download', label: string, icon: React.ReactNode, active = false) =>
    narrow ? (
      <IconButton
        aria-label={label}
        aria-haspopup="menu"
        onClick={(e) => setMenu({ kind, anchor: e.currentTarget })}
        color={active ? 'primary' : 'default'}
        sx={{ width: 44, height: 44 }}
        data-tool={kind}
      >
        {icon}
      </IconButton>
    ) : (
      <Button
        variant={active ? 'contained' : 'outlined'}
        color={active ? 'primary' : 'inherit'}
        startIcon={icon}
        aria-haspopup="menu"
        onClick={(e) => setMenu({ kind, anchor: e.currentTarget })}
        size="small"
        data-tool={kind}
      >
        {label}
      </Button>
    )

  return (
    <Stack spacing={narrow ? 1 : 0} sx={{ px: narrow ? 1.5 : 2, py: 1.25 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Stack sx={{ mr: 'auto', minWidth: 0 }}>
          <Typography component="h1" variant="subtitle1" sx={{ fontWeight: 600, lineHeight: '22px' }} noWrap>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary" data-counter="">
            {counter}
          </Typography>
        </Stack>
        {stale ? (
          <Chip
            size="small"
            icon={<RefreshIcon fontSize="small" />}
            label={narrow ? 'Обновить порядок' : 'Порядок не обновлён — обновить'}
            onClick={(e) => props.onRefresh(e.timeStamp)}
            data-stale=""
          />
        ) : null}
        {narrow ? null : search}
        {button('filter', 'Фильтр', <FilterIcon fontSize="small" />, filtered)}
        {button('sort', 'Сортировка', <SortIcon fontSize="small" />, sorting.length > 0)}
        {button('download', 'Скачать', <DownloadIcon fontSize="small" />)}
      </Stack>
      {narrow ? search : null}

      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'filter'} onClose={close} transitionDuration={0}>
        <ListSubheader>Категории</ListSubheader>
        {CATEGORIES.map((c) => {
          const on = filters.categories.includes(c)
          return (
            <MenuItem
              key={c}
              onClick={(e) =>
                props.onFilters(
                  { ...filters, categories: on ? filters.categories.filter((x) => x !== c) : [...filters.categories, c] },
                  e.timeStamp,
                )
              }
              data-category={c}
            >
              <ListItemIcon>
                <Checkbox edge="start" size="small" checked={on} tabIndex={-1} disableRipple />
              </ListItemIcon>
              <ListItemText>{c}</ListItemText>
            </MenuItem>
          )
        })}
        <Divider />
        <ListSubheader>В наличии</ListSubheader>
        {STOCKS.map((s) => (
          <MenuItem key={s.value} selected={filters.stock === s.value} onClick={(e) => props.onFilters({ ...filters, stock: s.value }, e.timeStamp)} data-stock={s.value}>
            {s.label}
          </MenuItem>
        ))}
        {filtered ? (
          // The item goes away with the filter: close the menu, or the focus falls to <body>
          // and Esc no longer reaches the menu.
          <MenuItem
            onClick={(e) => {
              props.onFilters({ ...filters, categories: [], stock: 'all' }, e.timeStamp)
              close()
            }}
          >
            Сбросить фильтр
          </MenuItem>
        ) : null}
      </Menu>

      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'sort'} onClose={close} transitionDuration={0}>
        {SORTS.map((s) => (
          <MenuItem
            key={s.label}
            selected={same(s.sorting, sorting)}
            onClick={(e) => {
              props.onSorting(s.sorting, e.timeStamp)
              close()
            }}
            data-sort={s.label}
          >
            {s.label}
          </MenuItem>
        ))}
      </Menu>

      <Menu anchorEl={menu?.anchor} open={menu?.kind === 'download'} onClose={close} transitionDuration={0}>
        <MenuItem
          onClick={() => {
            props.onDownload('xlsx')
            close()
          }}
          data-download="xlsx"
        >
          <ListItemText primary="Excel (.xlsx)" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            props.onDownload('csv')
            close()
          }}
          data-download="csv"
        >
          <ListItemText primary="CSV для Excel" secondary="Через «;», в UTF-8" />
        </MenuItem>
      </Menu>
    </Stack>
  )
}
