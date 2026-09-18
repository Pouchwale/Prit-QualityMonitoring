import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Query } from '../services/api'

/** Loads an API resource and reloads it when the path or query changes (like the web panel's useApi). */
export function useQuery<T>(path: string | null, query?: Query) {
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

export const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong')
