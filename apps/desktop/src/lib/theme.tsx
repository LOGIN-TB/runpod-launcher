import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

const STORAGE_KEY = 'launcher.theme'

/**
 * Three states, not two.
 *
 * "System" is the default and has to stay a state of its own: someone whose
 * machine switches at dusk wants the app to switch with it, and a plain toggle
 * would silently pin them to whatever it was set to at the time.
 */
export type Theme = 'system' | 'light' | 'dark'

interface ThemeValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark'

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isTheme(stored) ? stored : 'system'
  })

  useEffect(() => {
    const root = document.documentElement
    // Nothing is stamped for "system", which is what lets the stylesheet's
    // `prefers-color-scheme` rule apply. An attribute would override it.
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      setTheme: (next) => {
        localStorage.setItem(STORAGE_KEY, next)
        setThemeState(next)
      },
    }),
    [theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
