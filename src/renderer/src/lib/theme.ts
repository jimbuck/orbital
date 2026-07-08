import { useEffect, useState } from 'react'
import { useStore } from '../store'

/** The concrete theme actually applied to the DOM — 'system' has been resolved away. */
export type ResolvedTheme = 'light' | 'dark'

/** Media query used to resolve the 'system' theme against the OS preference. */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Resolve the persisted theme setting to a concrete 'light'|'dark'.
 *
 * Reads `settings.theme` from the store (defaulting to 'dark' before settings
 * load or for installs predating this setting, which preserves the original
 * dark-only look). When the mode is 'system' it tracks the OS preference live
 * via matchMedia, so toggling the OS theme re-themes the app without a reload.
 */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useStore((s) => s.settings?.theme) ?? 'dark'

  // Seed from the current OS preference; only consulted while mode === 'system'.
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
  )

  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    // Sync once on subscribe in case the preference changed while not tracking.
    setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}
