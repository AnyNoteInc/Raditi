'use client'

import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter'
import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ElementType,
  type ReactNode,
} from 'react'

import { createAppTheme } from '../theme/create-app-theme.ts'
import { serializeThemeCookie, type ThemePreference } from '../theme/theme-preference.ts'

export type ThemePreferenceContextValue = {
  preference: ThemePreference
  /** Writes the `theme` cookie and repaints right away. */
  setPreference: (next: ThemePreference) => void
}

const ThemePreferenceContext = createContext<ThemePreferenceContextValue | null>(null)

export function useThemePreference(): ThemePreferenceContextValue {
  const value = use(ThemePreferenceContext)
  if (!value) throw new Error('useThemePreference must be used inside UiProvider')
  return value
}

export type UiProviderProps = {
  /**
   * The `theme` cookie parsed on the server with `parseThemePreference`. It is the only source
   * of the colour mode: nothing is kept in local storage.
   */
  themePreference: ThemePreference
  /** next/link, passed from the app's client providers file. */
  linkComponent?: ElementType
  children: ReactNode
}

export function UiProvider({ themePreference, linkComponent, children }: UiProviderProps) {
  const [preference, setPreferenceState] = useState(themePreference)

  const setPreference = useCallback((next: ThemePreference) => {
    document.cookie = serializeThemeCookie(next, { secure: window.location.protocol === 'https:' })
    setPreferenceState(next)
  }, [])

  const theme = useMemo(
    () => createAppTheme(preference, { linkComponent }),
    [preference, linkComponent],
  )
  const preferenceValue = useMemo(
    () => ({ preference, setPreference }),
    [preference, setPreference],
  )

  return (
    <AppRouterCacheProvider options={{ key: 'css', enableCssLayer: true }}>
      <ThemePreferenceContext value={preferenceValue}>
        {/* storageManager={null}: MUI must not keep its own copy of the mode in local storage. */}
        <ThemeProvider theme={theme} storageManager={null}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </ThemePreferenceContext>
    </AppRouterCacheProvider>
  )
}
