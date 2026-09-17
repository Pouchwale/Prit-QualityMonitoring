import type { CurrentUser } from '../types'

/** Backend address. Set VITE_API_URL to override; defaults to port 4000 on the same host. */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || `${window.location.protocol}//${window.location.hostname}:4000`).replace(/\/$/, '')

/** Turns a media path like /uploads/... into a full URL. */
export const mediaUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${API_URL}${url}`)

const ACCESS_KEY = 'quality.admin.accessToken'
const REFRESH_KEY = 'quality.admin.refreshToken'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

let unauthorizedHandler: (() => void) | null = null
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler
}

const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* storage unavailable */
    }
  },
  remove: (key: string) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* storage unavailable */
    }
  }
}

function saveTokens(tokens: { accessToken: string; refreshToken: string }) {
  storage.set(ACCESS_KEY, tokens.accessToken)
  storage.set(REFRESH_KEY, tokens.refreshToken)
}

export function clearTokens() {
  storage.remove(ACCESS_KEY)
  storage.remove(REFRESH_KEY)
}

export const hasSession = () => !!(storage.get(ACCESS_KEY) || storage.get(REFRESH_KEY))

async function send(path: string, init: RequestInit) {
  try {
    return await fetch(`${API_URL}${path}`, init)
  } catch {
    throw new ApiError(0, `Cannot reach the server at ${API_URL}. Is the backend running?`)
  }
}

async function errorMessage(res: Response) {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string') return body.error
  } catch {
    /* not JSON */
  }
  return `Request failed (${res.status})`
}

let refreshing: Promise<boolean> | null = null
function refresh(): Promise<boolean> {
  const token = storage.get(REFRESH_KEY)
  if (!token) return Promise.resolve(false)
  refreshing ??= (async () => {
    try {
      const res = await send('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token })
      })
      if (!res.ok) return false
      saveTokens(await res.json())
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

type Query = Record<string, string | number | boolean | null | undefined>

function withQuery(path: string, query?: Query) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = storage.get(ACCESS_KEY)
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await send(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })

  if (res.status === 401 && retry && (await refresh())) return request<T>(method, path, body, false)
  if (res.status === 401) {
    clearTokens()
    unauthorizedHandler?.()
    throw new ApiError(401, await errorMessage(res))
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res))
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', withQuery(path, query)),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T = { result: 'deleted' | 'disabled' }>(path: string) => request<T>('DELETE', path)
}

/**
 * Downloads a file (e.g. the report PDF) with the signed-in user's token and saves it
 * with the filename the server sends.
 */
export async function download(path: string, query?: Query, fallbackName = 'download') {
  const token = storage.get(ACCESS_KEY)
  const res = await send(withQuery(path, query), {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  if (res.status === 401 && (await refresh())) return download(path, query, fallbackName)
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res))

  const disposition = res.headers.get('content-disposition') ?? ''
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return name
}

export async function login(employeeId: string, password: string): Promise<CurrentUser> {
  const res = await send('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId, password, app: 'admin' })
  })
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res))
  const data = await res.json()
  saveTokens(data)
  return data.user
}

export async function logout() {
  try {
    await request('POST', '/api/auth/logout', {}, false)
  } catch {
    /* ignore */
  }
  clearTokens()
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const tokens = await api.post<{ accessToken: string; refreshToken: string }>('/api/auth/change-password', {
    currentPassword,
    newPassword
  })
  saveTokens(tokens)
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong')
