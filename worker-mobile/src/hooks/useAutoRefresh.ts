import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'

/** Runs `refresh` every `intervalMs` and whenever the app comes back to the foreground. */
export function useAutoRefresh(refresh: () => void, intervalMs = 60_000) {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    const timer = setInterval(() => latest.current(), intervalMs)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') latest.current()
    })
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [intervalMs])
}
