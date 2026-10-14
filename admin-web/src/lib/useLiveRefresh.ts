import { useEffect, useRef, useState } from 'react'
import { api } from './api'

export interface LiveState {
  /** live: the last check worked; offline: it failed and is being retried. */
  status: 'live' | 'offline'
  /** When the page last confirmed it shows the server's data. */
  syncedAt: Date | null
}

/**
 * Keeps a page in step with the server without a manual refresh. The app has no push channel
 * (WebSocket / Server-Sent Events), so every `intervalMs` it asks `versionPath` for a small
 * fingerprint of the data and calls `refresh` only when that changed. Paused while the tab is
 * hidden; checks at once when the tab is shown again or the network comes back. A failed check or
 * refresh is retried on the next round, so a change made while offline still arrives.
 */
export function useLiveRefresh(versionPath: string, refresh: () => Promise<unknown>, intervalMs = 5000): LiveState {
  const [state, setState] = useState<LiveState>({ status: 'live', syncedAt: null })
  const lastVersion = useRef<string | null>(null)
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false

    const next = () => {
      if (!stopped) timer = setTimeout(check, intervalMs)
    }
    const check = async () => {
      if (running) return
      if (document.visibilityState === 'hidden') return next()
      running = true
      try {
        const { version } = await api.get<{ version: string }>(versionPath)
        // The first answer also refreshes: a change between the page's own load and now is not missed.
        if (version !== lastVersion.current) await refreshRef.current()
        lastVersion.current = version
        if (!stopped) setState({ status: 'live', syncedAt: new Date() })
      } catch {
        if (!stopped) setState((s) => ({ ...s, status: 'offline' }))
      } finally {
        running = false
        next()
      }
    }
    const now = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      void check()
    }

    void check()
    document.addEventListener('visibilitychange', now)
    window.addEventListener('online', now)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', now)
      window.removeEventListener('online', now)
    }
  }, [versionPath, intervalMs])

  return state
}
