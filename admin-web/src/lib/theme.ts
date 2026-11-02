import { useCallback, useEffect, useState } from 'react'

/**
 * Light / dark theme for the admin panel. The choice is saved in this browser (localStorage) and
 * set as <html data-theme="dark">; index.css swaps the colour tokens for that attribute. index.html
 * applies the saved choice before the first paint, so a reload never flashes the other theme.
 * Light is the default. The worker app is separate and is not affected.
 */
export type Theme = 'light' | 'dark'

/** Also read by the inline script in index.html; keep the two in step. */
export const THEME_KEY = 'qa-admin-theme'

const read = (): Theme => {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

const apply = (theme: Theme) => {
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
}

/** Cross-fades the page into the new theme where the browser supports it and motion is allowed. */
const applySmoothly = (theme: Theme) => {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown }
  if (!reduced && typeof doc.startViewTransition === 'function') doc.startViewTransition(() => apply(theme))
  else apply(theme)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(read)

  // Another tab changed the theme: follow it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY && e.key !== null) return
      const next = read()
      apply(next)
      setThemeState(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* storage unavailable: the theme still changes for this visit */
    }
    applySmoothly(next)
    setThemeState(next)
  }, [])

  return { theme, setTheme }
}
