import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Query } from '../services/api'
import { friendlyMessage } from '../utils/friendlyError'

/**
 * Loads an API resource and reloads it when the path or query changes (like the web panel's useApi).
 *
 * `load` reads the answer; the default returns the JSON body. A paged list passes `api.getPage`
 * instead, which also reports how many entries match in total.
 */
export function useQuery<T>(path: string | null, query?: Query, load: (path: string, query?: Query) => Promise<T> = api.get) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const queryKey = JSON.stringify(query ?? {})
  const requestId = useRef(0)
  // Kept in a ref so passing an inline loader cannot start an endless reload.
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })

  const reload = useCallback(async () => {
    if (path === null) return
    const id = ++requestId.current
    setLoading(true)
    try {
      const result = await loader.current(path, JSON.parse(queryKey))
      if (id === requestId.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if (id === requestId.current) setError(errorText(err))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [path, queryKey])

  useEffect(() => {
    reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}

/** What went wrong in plain words, with what to do next; technical details are never shown. */
export const errorText = (err: unknown) => friendlyMessage(err)
