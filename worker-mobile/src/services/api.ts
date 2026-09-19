import Constants from 'expo-constants'
import { Platform } from 'react-native'
import {
  AssignedMachine,
  Capture,
  CheckForm,
  CheckRecord,
  CheckSummary,
  EvidenceUpload,
  HandoverOptions,
  HistoryFilterOptions,
  HistoryPage,
  HistoryQuery,
  Job,
  JobDetail,
  Profile,
  SubmitResult,
  SubmitValue
} from '../types'
import { tokenStorage } from './storage'
import { normalizeServerUrl } from './serverUrl'

export { normalizeServerUrl }

/**
 * The server the app was built for: EXPO_PUBLIC_API_URL (eas.json) in an APK. The web app is
 * served by the backend itself, so it uses the address it was opened from. During development the
 * phone app uses the computer running Expo (the same PC normally runs the backend) on port 4000.
 */
function defaultApiUrl() {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin
  const host = Constants.expoConfig?.hostUri?.split(':')[0]
  return `http://${host ?? 'localhost'}:4000`
}

export const DEFAULT_API_URL = defaultApiUrl()
const SERVER_KEY = 'quality.serverUrl'

/**
 * The server every request goes to. It is the built-in address unless one was set on this
 * device (Sign in -> Server settings), which is kept after the app restarts, so the same APK
 * works when the server's IP address changes.
 */
let apiUrl = DEFAULT_API_URL
export const getApiUrl = () => apiUrl
/**
 * The phone app can be pointed at another server. The web app cannot: it is served by the
 * backend and may only talk to the site it was opened from (the backend's security policy), so
 * its server is simply the address it was opened at. Development builds allow it for testing.
 */
export const canChangeServer = Platform.OS !== 'web' || __DEV__
/** Whether this device uses an address set in the app instead of the built-in one. */
export const usesCustomServer = () => apiUrl !== DEFAULT_API_URL

/** Reads the address saved on this device. Called once when the app starts. */
export async function loadServerUrl() {
  const saved = canChangeServer ? await tokenStorage.get(SERVER_KEY).catch(() => null) : null
  apiUrl = saved || DEFAULT_API_URL
  return apiUrl
}

/**
 * Checks that a Quality Monitoring backend answers at this address (GET /api/health), within
 * `timeoutMs`. Throws an ApiError with a message for the worker when it does not.
 */
export async function testServer(url: string, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${url}/api/health`, { headers: { Accept: 'application/json' }, signal: controller.signal })
  } catch {
    throw new ApiError(0, `No answer from ${url}. Check the address, that the server is running and that this phone is on the same network.`)
  } finally {
    clearTimeout(timer)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok !== true) {
    throw new ApiError(res.status, `${url} answered, but it is not the Quality Monitoring server. Check the address and port (usually 4000).`)
  }
}

/**
 * Uses this server from now on and keeps it on the device; null goes back to the built-in
 * address. The sign-in stays: it keeps working when the same server only got a new address,
 * and a different server simply asks to sign in again.
 */
export async function setServerUrl(url: string | null) {
  if (url && url !== DEFAULT_API_URL) await tokenStorage.set(SERVER_KEY, url)
  else await tokenStorage.remove(SERVER_KEY)
  apiUrl = url || DEFAULT_API_URL
}

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
    return await fetch(`${apiUrl}${path}`, init)
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
    xhr.open('POST', `${apiUrl}${path}`)
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
    // One app for every role: the backend decides what this account may use.
    body: JSON.stringify({ employeeId, password, app: 'mobile' })
  })
  if (!res.ok) throw new ApiError(res.status, await readError(res))
  const data = await res.json()
  await saveTokens(data)
  return data.user
}

/** Restores a saved session. Returns null when the user needs to sign in. */
export async function restoreSession(): Promise<Profile | null> {
  await loadServerUrl()
  accessToken = await tokenStorage.get(ACCESS_KEY)
  refreshToken = await tokenStorage.get(REFRESH_KEY)
  if (!accessToken && !refreshToken) return null
  try {
    // Works for every role and includes the module permissions.
    return await request<Profile>('GET', '/api/auth/me')
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

/** Super Admin only (the backend refuses everyone else): changes the password and keeps this device signed in. */
export async function changePassword(currentPassword: string, newPassword: string) {
  const tokens = await request<{ accessToken: string; refreshToken: string }>('POST', '/api/auth/change-password', { currentPassword, newPassword })
  await saveTokens(tokens)
}

/** The signed-in user's latest profile and permissions (an Admin may have changed them). */
export const getMe = () => request<Profile>('GET', '/api/auth/me')

// ---- Generic API (admin and manager screens) ----

export type Query = Record<string, string | number | boolean | null | undefined>

export function withQuery(path: string, query?: Query) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path
}

/** The same endpoints as the web admin panel; the backend enforces every permission. */
export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', withQuery(path, query)),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T = { result: string }>(path: string) => request<T>('DELETE', path)
}

/** A file picked on the device (document picker), for multipart uploads. */
export interface PickedFile {
  uri: string
  name: string
  mimeType?: string | null
  /** Web: the browser File. */
  file?: Blob | null
}

export function uploadFile<T>(path: string, field: string, file: PickedFile, onProgress?: UploadProgress) {
  return upload<T>(
    path,
    () => {
      const form = new FormData()
      if (file.file) form.append(field, file.file, file.name)
      else form.append(field, { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as unknown as Blob)
      return form
    },
    onProgress
  )
}

/** A fresh access token for authenticated downloads (refreshed first if it expired). */
export async function authHeaders(path = '/api/auth/me'): Promise<Record<string, string>> {
  if (accessToken) {
    const probe = await send(path === '/api/auth/me' ? path : '/api/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } })
    if (probe.status !== 401) return { Authorization: `Bearer ${accessToken}` }
  }
  if (await tryRefresh()) return { Authorization: `Bearer ${accessToken}` }
  await clearTokens()
  sessionExpiredHandler?.()
  throw new ApiError(401, 'Session expired. Please sign in again.')
}

export { readError }

// ---- Worker ----

export const getProfile = () => request<Profile>('GET', '/api/worker/profile')
export const getTodayChecks = () => request<CheckSummary[]>('GET', '/api/worker/checks/today')

/** Whether the plant is closed today (Plant Calendar). */
export interface PlantStatus {
  closed: boolean
  label?: string
  reason?: string | null
  /** True when today's machine day plan decides this status. */
  planned?: boolean
  /** Only when the worker's machines run by plan: whether the plant itself is closed today. */
  plantClosed?: boolean
  /** Today's machine day plan for this worker's machines; null when there is no plan. */
  machinePlan?: { planned: boolean; runningMachineIds: string[]; count: number } | null
}
export const getPlantStatus = () => request<PlantStatus>('GET', '/api/worker/plant-status')

/** Full address of a photo or video returned by the API. */
export const fileUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${apiUrl}${url}`)

export function getHistory(query: HistoryQuery = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return request<HistoryPage>('GET', `/api/worker/checks/history${qs ? `?${qs}` : ''}`)
}

export const getHistoryFilters = () => request<HistoryFilterOptions>('GET', '/api/worker/history/filters')

/**
 * Machines the admin has assigned to this worker, each with its running job and, per check
 * type, the mode, the open check and when the next check is due.
 */
export const getMyMachines = () => request<AssignedMachine[]>('GET', '/api/worker/machines')

/**
 * Starts a check on the machine without waiting for an alert. The schedule's open check is
 * reused when there is one, so a machine never ends up with two open checks of the same type.
 */
export const startManualCheck = (machineId: string, activityId: string) =>
  request<CheckSummary & { created: boolean }>('POST', `/api/worker/machines/${machineId}/checks`, { activityId })

/**
 * Start Job: a planned job, or a new one with its Job No. and Item Code. The job waits for the
 * returned Job Start check(s) before its scheduled checks begin.
 */
export const startJob = (machineId: string, job: { plannedJobId: string } | { jobNo: string; itemCode?: string }) =>
  request<{ job: Job; startChecks: CheckSummary[] }>('POST', `/api/worker/machines/${machineId}/jobs`, job)

/** End Job: returns the Job End check(s); the job completes when they are submitted. */
export const endJob = (jobId: string) => request<{ job: Job; endChecks: CheckSummary[] }>('POST', `/api/worker/jobs/${jobId}/end`)

/** A job with its history, handovers and this worker's open checks. */
export const getJob = (jobId: string) => request<JobDetail>('GET', `/api/worker/jobs/${jobId}`)

/** The shifts and the workers on this machine who can take the job over. */
export const getHandoverOptions = (jobId: string) => request<HandoverOptions>('GET', `/api/worker/jobs/${jobId}/handover-options`)

/** Handover Job: the job and its open checks move to that worker, who is notified. */
export const handoverJob = (jobId: string, data: { toUserId: string; shiftId: string | null; note: string }) =>
  request<{ job: Job; movedChecks: number }>('POST', `/api/worker/jobs/${jobId}/handover`, data)

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

/**
 * Adds one capture as the multipart field the backend expects: `photo` / `video` for the
 * overall check evidence, `photo:<parameterId>` / `video:<parameterId>` per parameter.
 */
function appendFile(form: FormData, field: string, capture: Capture) {
  const isPhoto = !field.startsWith('video')
  const name = isPhoto ? 'photo' : 'video'
  // Web app: the browser captured a real file.
  if (capture.blob) {
    const type = capture.mimeType || capture.blob.type || (isPhoto ? 'image/jpeg' : 'video/webm')
    const ext = type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : type.split('/')[1]?.split(';')[0] || 'bin'
    form.append(field, capture.blob, `${name}.${ext}`)
    return
  }
  const last = capture.uri.split('?')[0].split('/').pop() ?? ''
  const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : isPhoto ? 'jpg' : 'mp4'
  const type = isPhoto ? (ext === 'png' ? 'image/png' : 'image/jpeg') : ext === 'mov' ? 'video/quicktime' : 'video/mp4'
  // React Native's XMLHttpRequest sends { uri, name, type } parts as files.
  form.append(field, { uri: capture.uri, name: `${name}.${ext}`, type } as unknown as Blob)
}

export interface CheckSubmission {
  itemCode: string
  jobNo: string
  /** Readings, and the parameters marked Not Applicable with their reason. */
  values: SubmitValue[]
  /** Every photo and video, per parameter and overall (see EvidenceUpload). */
  media: EvidenceUpload[]
}

export function submitCheck(checkId: string, data: CheckSubmission, onProgress?: UploadProgress) {
  return upload<SubmitResult>(
    `/api/worker/checks/${checkId}/submit`,
    () => {
      const form = new FormData()
      // Text fields go first, so the server has them even if the upload is cut short.
      form.append('itemCode', data.itemCode)
      form.append('jobNo', data.jobNo)
      form.append('values', JSON.stringify(data.values))
      form.append(
        'evidence',
        JSON.stringify(
          data.media.map((m) => ({
            field: m.field,
            capturedAt: m.capture.capturedAt,
            ...(m.capture.durationSeconds != null ? { durationSeconds: m.capture.durationSeconds } : {})
          }))
        )
      )
      form.append('deviceInfo', deviceInfo())
      // Legacy fields for the overall check photo/video, still read by older servers.
      const overallPhoto = data.media.find((m) => m.field === 'photo')
      const overallVideo = data.media.find((m) => m.field === 'video')
      if (overallPhoto) form.append('photoCapturedAt', overallPhoto.capture.capturedAt)
      if (overallVideo) {
        form.append('videoCapturedAt', overallVideo.capture.capturedAt)
        if (overallVideo.capture.durationSeconds != null) {
          form.append('videoDurationSeconds', String(overallVideo.capture.durationSeconds))
        }
      }
      for (const m of data.media) appendFile(form, m.field, m.capture)
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
      form.append('photoCapturedAt', data.photo.capturedAt)
      appendFile(form, 'photo', data.photo)
      return form
    },
    onProgress
  )
}
