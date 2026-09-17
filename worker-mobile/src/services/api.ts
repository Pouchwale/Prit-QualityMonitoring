import Constants from 'expo-constants'
import { Platform } from 'react-native'
import {
  Capture,
  CheckForm,
  CheckRecord,
  CheckSummary,
  HistoryFilterOptions,
  HistoryPage,
  HistoryQuery,
  Profile
} from '../types'
import { tokenStorage } from './storage'

/**
 * Backend address. Set EXPO_PUBLIC_API_URL for a fixed server. The web app is served by the
 * backend itself, so it uses the address it was opened from. During development the phone
 * app uses the computer running Expo (the same PC normally runs the backend) on port 4000.
 */
function resolveApiUrl() {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin
  const host = Constants.expoConfig?.hostUri?.split(':')[0]
  return `http://${host ?? 'localhost'}:4000`
}

export const API_URL = resolveApiUrl()

const ACCESS_KEY = 'quality.accessToken'
const REFRESH_KEY = 'quality.refreshToken'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

let accessToken: string | null = null
let refreshToken: string | null = null
let sessionExpiredHandler: (() => void) | null = null

/** Called when the session can no longer be refreshed, so the app can show the login page. */
export function onSessionExpired(handler: () => void) {
  sessionExpiredHandler = handler
}

async function saveTokens(tokens: { accessToken: string; refreshToken: string }) {
  accessToken = tokens.accessToken
  refreshToken = tokens.refreshToken
  await tokenStorage.set(ACCESS_KEY, tokens.accessToken)
  await tokenStorage.set(REFRESH_KEY, tokens.refreshToken)
}

async function clearTokens() {
  accessToken = null
  refreshToken = null
  await tokenStorage.remove(ACCESS_KEY)
  await tokenStorage.remove(REFRESH_KEY)
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, init)
  } catch (err) {
    console.warn(`Request to ${path} failed`, err)
    throw new ApiError(0, 'Cannot reach the server. Check the Wi-Fi and try again.')
  }
}

async function readError(res: Response) {
  try {
    const body = await res.json()
    return typeof body?.error === 'string' ? body.error : `Server error (${res.status})`
  } catch {
    return `Server error (${res.status})`
  }
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false
  const res = await send('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  })
  if (!res.ok) return false
  await saveTokens(await res.json())
  return true
}

async function request<T>(method: string, path: string, json?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  if (json !== undefined) headers['Content-Type'] = 'application/json'

  const res = await send(path, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined
  })

  if (res.status === 401 && retry && (await tryRefresh())) {
    return request<T>(method, path, json, false)
  }
  if (res.status === 401) {
    await clearTokens()
    sessionExpiredHandler?.()
    throw new ApiError(401, await readError(res))
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res))
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export type UploadProgress = (fraction: number) => void

/**
 * Multipart upload with XMLHttpRequest. Expo's global fetch cannot send React Native
 * file parts ({ uri, name, type }) and would load whole videos into memory; XHR streams
 * the files from disk and reports progress.
 */
function sendForm(path: string, form: FormData, onProgress?: UploadProgress): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_URL}${path}`)
    xhr.setRequestHeader('Accept', 'application/json')
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    xhr.timeout = 15 * 60_000
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(Math.min(e.loaded / e.total, 1))
      }
    }
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
    xhr.onerror = () => reject(new ApiError(0, 'Cannot reach the server. Check the Wi-Fi and try again.'))
    xhr.ontimeout = () => reject(new ApiError(0, 'Sending took too long. Check the Wi-Fi and try again.'))
    xhr.send(form)
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function upload<T>(path: string, buildForm: () => FormData, onProgress?: UploadProgress, retry = true): Promise<T> {
  const res = await sendForm(path, buildForm(), onProgress)
  if (res.status === 401 && retry && (await tryRefresh())) {
    return upload<T>(path, buildForm, onProgress, false)
  }
  const body = parseJson(res.text) as { error?: string } | null
  if (res.status === 401) {
    await clearTokens()
    sessionExpiredHandler?.()
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : `Server error (${res.status})`)
  }
  return body as T
}

// ---- Auth ----

export async function login(employeeId: string, password: string): Promise<Profile> {
  const res = await send('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId, password, app: 'worker' })
  })
  if (!res.ok) throw new ApiError(res.status, await readError(res))
  const data = await res.json()
  await saveTokens(data)
  return data.user
}

/** Restores a saved session. Returns null when the worker needs to sign in. */
export async function restoreSession(): Promise<Profile | null> {
  accessToken = await tokenStorage.get(ACCESS_KEY)
  refreshToken = await tokenStorage.get(REFRESH_KEY)
  if (!accessToken && !refreshToken) return null
  try {
    return await request<Profile>('GET', '/api/worker/profile')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export async function logout() {
  try {
    if (accessToken) await request('POST', '/api/auth/logout', undefined, false)
  } catch {
    // Signing out locally is enough if the server cannot be reached.
  }
  await clearTokens()
}

// ---- Worker ----

export const getProfile = () => request<Profile>('GET', '/api/worker/profile')
export const getTodayChecks = () => request<CheckSummary[]>('GET', '/api/worker/checks/today')

/** Whether the plant is closed today (Plant Calendar). */
export interface PlantStatus {
  closed: boolean
  label?: string
  reason?: string | null
}
export const getPlantStatus = () => request<PlantStatus>('GET', '/api/worker/plant-status')

/** Full address of a photo or video returned by the API. */
export const fileUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${API_URL}${url}`)

export function getHistory(query: HistoryQuery = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return request<HistoryPage>('GET', `/api/worker/checks/history${qs ? `?${qs}` : ''}`)
}

export const getHistoryFilters = () => request<HistoryFilterOptions>('GET', '/api/worker/history/filters')

/** Machines the admin has assigned to this worker. */
export const getMyMachines = () => request<{ id: string; name: string; code: string }[]>('GET', '/api/worker/machines')

export const registerPushToken = (token: string, platform: string) =>
  request<void>('PUT', '/api/worker/push-token', { token, platform })

/** Web app: registers this browser's push subscription (endpoint + keys). */
export const registerWebPush = (subscription: PushSubscriptionJSON, platform: string) =>
  request<void>('PUT', '/api/worker/push-token', { kind: 'web', subscription, platform })

export const getWebPushKey = () => request<{ publicKey: string }>('GET', '/api/worker/push/web-key')

export type AlertStatus =
  | 'registered'
  | 'permission-denied'
  | 'no-project-id'
  | 'expo-go-unsupported'
  | 'insecure-context'
  | 'ios-needs-home-screen'
  | 'unsupported-browser'
  | 'error'

/** Tells the backend whether this device could turn on alerts, so "Test alert" can explain failures. */
export const reportAlertStatus = (status: AlertStatus, platform: string, detail?: string) =>
  request<void>('PUT', '/api/worker/push-status', { status, platform, detail: detail?.slice(0, 300) }).catch(() => undefined)

export const deletePushToken = (token: string) => request<void>('DELETE', '/api/worker/push-token', { token })
export const getCheckRecord = (checkId: string) => request<CheckRecord>('GET', `/api/worker/checks/${checkId}/record`)
export const getCheckForm = (checkId: string) => request<CheckForm>('GET', `/api/worker/checks/${checkId}`)

const deviceInfo = () =>
  Platform.OS === 'web'
    ? `web · ${typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 160) : 'browser'}`
    : `${Platform.OS} ${Platform.Version} · ${Constants.deviceName ?? 'unknown device'}`

function appendFile(form: FormData, field: 'photo' | 'video', capture: Capture) {
  // Web app: the browser captured a real file.
  if (capture.blob) {
    const type = capture.mimeType || capture.blob.type || (field === 'photo' ? 'image/jpeg' : 'video/webm')
    const ext = type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : type.split('/')[1]?.split(';')[0] || 'bin'
    form.append(`${field}CapturedAt`, capture.capturedAt)
    form.append(field, capture.blob, `${field}.${ext}`)
    return
  }
  const last = capture.uri.split('?')[0].split('/').pop() ?? ''
  const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : field === 'photo' ? 'jpg' : 'mp4'
  const type =
    field === 'photo' ? (ext === 'png' ? 'image/png' : 'image/jpeg') : ext === 'mov' ? 'video/quicktime' : 'video/mp4'
  // Text fields go before the file so the server has them even if the upload is cut short.
  form.append(`${field}CapturedAt`, capture.capturedAt)
  // React Native's XMLHttpRequest sends { uri, name, type } parts as files.
  form.append(field, { uri: capture.uri, name: `${field}.${ext}`, type } as unknown as Blob)
}

export function submitCheck(
  checkId: string,
  data: { jobNo: string; values: { parameterId: string; value: string }[]; photo: Capture | null; video: Capture | null },
  onProgress?: UploadProgress
) {
  return upload<CheckSummary>(
    `/api/worker/checks/${checkId}/submit`,
    () => {
      const form = new FormData()
      form.append('jobNo', data.jobNo)
      form.append('values', JSON.stringify(data.values))
      form.append('deviceInfo', deviceInfo())
      if (data.video?.durationSeconds != null) form.append('videoDurationSeconds', String(data.video.durationSeconds))
      if (data.photo) appendFile(form, 'photo', data.photo)
      if (data.video) appendFile(form, 'video', data.video)
      return form
    },
    onProgress
  )
}

export function submitException(
  checkId: string,
  data: { reason: string; remark: string; photo: Capture },
  onProgress?: UploadProgress
) {
  return upload<CheckSummary>(
    `/api/worker/checks/${checkId}/exception`,
    () => {
      const form = new FormData()
      form.append('reason', data.reason)
      form.append('remark', data.remark)
      form.append('deviceInfo', deviceInfo())
      appendFile(form, 'photo', data.photo)
      return form
    },
    onProgress
  )
}
