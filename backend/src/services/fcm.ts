import fs from 'node:fs'
import path from 'node:path'
import { createSign } from 'node:crypto'

/**
 * Due-check alerts sent straight to Firebase Cloud Messaging (FCM HTTP v1) as high-priority
 * data-only messages, for Android phones whose app registered its Firebase token (app 1.2.0+).
 *
 * Why: a normal push (title + text, as Expo sends it) is shown by Android itself while the app is in
 * the background or closed, and no app code runs, so nothing can speak it. A data-only message always
 * reaches the app: expo-notifications still shows the same notification (it reads the title, text and
 * data from the message's data fields, in native code, no JavaScript needed), and the app's voice
 * service speaks it, even with the app closed and the phone locked.
 *
 * Only the transport differs: the same title, text and data as the Expo push. When Firebase is not
 * set up, the phone has no Firebase token, or Firebase refuses or fails, services/notifications.ts
 * sends the Expo push as before.
 *
 * Firebase access: a service-account key file of the Firebase project, kept on the server only:
 * FIREBASE_SERVICE_ACCOUNT_FILE (default backend/secrets/firebase-service-account.json, which is
 * never committed: backend/secrets/ is in .gitignore). Without the file, this is simply off.
 */

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const FCM_URL = 'https://fcm.googleapis.com'
const tokenUrl = (account: ServiceAccount) => account.token_uri ?? 'https://oauth2.googleapis.com/token'

const keyFile = () => path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_FILE ?? 'secrets/firebase-service-account.json')

let account: ServiceAccount | null | undefined
let warned = false

/** The service account, read once; null (Firebase off) when the file is missing or unusable. */
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account
  const file = keyFile()
  try {
    if (!fs.existsSync(file)) return (account = null)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServiceAccount>
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) throw new Error('missing project_id, client_email or private_key')
    account = parsed as ServiceAccount
    console.log(`Firebase alerts on (project ${account.project_id})`)
  } catch (err) {
    // Never print the key itself.
    if (!warned) console.warn(`Firebase alerts off: the service-account file ${file} cannot be used (${(err as Error).message})`)
    warned = true
    account = null
  }
  return account
}

/** Whether due-check alerts can go through Firebase. */
export const fcmEnabled = () => serviceAccount() !== null

/** For tests: forget the cached service account and access token. */
export function resetFcmForTests() {
  account = undefined
  accessToken = null
  warned = false
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url')

let accessToken: { value: string; expiresAt: number } | null = null

/** An OAuth access token for FCM, from a signed service-account JWT; reused until shortly before it expires. */
async function getAccessToken(acc: ServiceAccount): Promise<string> {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: acc.client_email, scope: SCOPE, aud: tokenUrl(acc), iat: now, exp: now + 3600 }))
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(acc.private_key).toString('base64url')
  const res = await fetch(tokenUrl(acc), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`Google sign-in failed (HTTP ${res.status})`)
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new Error('Google sign-in returned no access token')
  accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return accessToken.value
}

export interface FcmAlert {
  title: string
  body: string
  /** The same data as the Expo push ({ checkId, voice, voiceId }). */
  data: Record<string, unknown>
  channelId: string
}

/** sent: Firebase took it. unregistered: the token is dead (drop it). failed: anything else (use Expo). */
export type FcmResult = 'sent' | 'unregistered' | 'failed'

/**
 * The message as expo-notifications expects a data-only push: `title`, `message` (the text), `body`
 * (the data as JSON) and `channelId`, all strings; high priority so it is delivered at once, also to
 * a sleeping phone, and the app may start its voice service.
 */
export function fcmMessage(token: string, alert: FcmAlert) {
  return {
    message: {
      token,
      data: { title: alert.title, message: alert.body, body: JSON.stringify(alert.data), channelId: alert.channelId },
      android: { priority: 'HIGH' as const }
    }
  }
}

/** Sends one alert to one phone through Firebase. Never throws. */
export async function sendFcmAlert(token: string, alert: FcmAlert): Promise<FcmResult> {
  const acc = serviceAccount()
  if (!acc) return 'failed'
  if (process.env.PUSH_DISABLED === '1') {
    console.log('Push disabled, would have sent 1 Firebase message', JSON.stringify(fcmMessage('(token)', alert)))
    return 'sent'
  }
  try {
    const res = await fetch(`${FCM_URL}/v1/projects/${encodeURIComponent(acc.project_id)}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getAccessToken(acc)}` },
      body: JSON.stringify(fcmMessage(token, alert)),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.ok) return 'sent'
    const error = (await res.json().catch(() => null)) as { error?: { status?: string; details?: { errorCode?: string }[] } } | null
    const code = error?.error?.details?.find((d) => d.errorCode)?.errorCode ?? error?.error?.status
    if (res.status === 401) accessToken = null
    // The token no longer belongs to an installed app.
    if (res.status === 404 || code === 'UNREGISTERED') return 'unregistered'
    console.warn(`Firebase refused an alert (HTTP ${res.status}${code ? `, ${code}` : ''}); sending it through Expo instead`)
    return 'failed'
  } catch (err) {
    console.warn(`Firebase could not be reached (${(err as Error).message}); sending the alert through Expo instead`)
    return 'failed'
  }
}
