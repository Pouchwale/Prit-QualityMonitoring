import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from './api'

type Query = Record<string, string | number | boolean | null | undefined>

/**
 * Loads `path` from the API and reloads when the path or query changes.
 * Pass `null` as path to skip loading.
 */
export function useApi<T>(path: string | null, query?: Query) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const queryKey = JSON.stringify(query ?? {})
  const requestId = useRef(0)

  const reload = useCallback(async () => {
    if (path === null) return
    const id = ++requestId.current
    setLoading(true)
    try {
      const result = await api.get<T>(path, JSON.parse(queryKey))
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
