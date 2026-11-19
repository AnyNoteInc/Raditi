import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon'

// Inline stroke icons, so the spike does not pull @mui/icons-material.
function make(path: string) {
  return function Icon(props: SvgIconProps) {
    return (
      <SvgIcon {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </SvgIcon>
    )
  }
}

export const SearchIcon = make('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4')
export const FilterIcon = make('M4 5h16l-6 8v5l-4 2v-7L4 5Z')
export const SortIcon = make('M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3')
export const DownloadIcon = make('M12 4v11M7 10l5 5 5-5M5 20h14')
export const PlusIcon = make('M12 5v14M5 12h14')
export const ArrowUpIcon = make('M12 19V5M6 11l6-6 6 6')
export const ArrowDownIcon = make('M12 5v14M6 13l6 6 6-6')
export const CloseIcon = make('M6 6l12 12M18 6 6 18')
export const RefreshIcon = make('M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5')
