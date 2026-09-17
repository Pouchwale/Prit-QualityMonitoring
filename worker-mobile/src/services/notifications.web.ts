import { CheckSummary } from '../types'
import { deletePushToken, getWebPushKey, registerWebPush, reportAlertStatus } from './api'

/**
 * "Check is due" alerts for the web app, using Web Push. Same interface as notifications.ts.
 *
 * The backend sends the alert to this browser's push subscription, and the service worker
 * (public/sw.js) shows it, also when the app is closed. Tapping it opens the check.
 *
 * Requirements the browser imposes:
 *  - a secure page (HTTPS, or localhost);
 *  - on iPhone/iPad (iOS 16.4+), the app must be added to the Home Screen and opened from
 *    there; Safari in a normal tab cannot receive push.
 */

let subscriptionEndpoint: string | null = null

/** The service worker lives next to index.html, so the app works under any base path (e.g. /app/). */
const swUrl = () => new URL('sw.js', document.baseURI).href
const swScope = () => new URL('./', document.baseURI).pathname

export const isExpoGo = false

export type WebAlertSupport = 'supported' | 'insecure' | 'unsupported' | 'ios-needs-home-screen'

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

/** Whether this browser can receive alerts, and if not, why. */
export function webAlertSupport(): WebAlertSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (!window.isSecureContext) return 'insecure'
  if (isIos() && !isStandalone()) return 'ios-needs-home-screen'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return 'supported'
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null

/** Registers the service worker once. Also makes the app installable and faster to reopen. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null)
  registration ??= navigator.serviceWorker
    .register(swUrl(), { scope: swScope() })
    .then(() => navigator.serviceWorker.ready)
    .catch((err) => {
      console.warn('Service worker registration failed', err)
      return null
    })
  return registration
}

export const usesServerPush = () => subscriptionEndpoint !== null
export const getPushToken = () => subscriptionEndpoint

export async function notificationsAllowed(): Promise<boolean> {
  return webAlertSupport() === 'supported' && Notification.permission === 'granted'
}

/**
 * Asks for permission. Browsers only allow this after the worker taps something, so the
 * Profile screen's "Turn on alerts" button calls it; on sign-in it only checks.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (webAlertSupport() !== 'supported') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    return (await Notification.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

function base64UrlToBytes(base64Url: string) {
  const padded = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const browserPlatform = () => (isIos() ? 'iPhone web app' : /Android/.test(navigator.userAgent) ? 'Android browser' : 'PC browser')

/** Subscribes this browser and registers it with the backend. Returns the endpoint, or null. */
export async function registerForPush(): Promise<string | null> {
  // Report why this browser cannot get alerts, so "Test alert" in the admin panel can explain it.
  const support = webAlertSupport()
  if (support !== 'supported') {
    const status = support === 'insecure' ? 'insecure-context' : support === 'ios-needs-home-screen' ? 'ios-needs-home-screen' : 'unsupported-browser'
    reportAlertStatus(status, browserPlatform(), window.location.origin)
    return null
  }
  if (Notification.permission !== 'granted') {
    reportAlertStatus('permission-denied', browserPlatform(), Notification.permission === 'denied' ? 'blocked in the browser' : 'not turned on yet')
    return null
  }
  try {
    const reg = await registerServiceWorker()
    if (!reg) return null
    const { publicKey } = await getWebPushKey()
    const key = base64UrlToBytes(publicKey)

    let subscription = await reg.pushManager.getSubscription()
    // A subscription made with another server key (keys were rotated) cannot be used.
    const currentKey = subscription?.options.applicationServerKey
    if (subscription && currentKey && !sameBytes(new Uint8Array(currentKey), key)) {
      await subscription.unsubscribe()
      subscription = null
    }
    subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })

    await registerWebPush(subscription.toJSON(), isIos() ? 'ios-web' : /Android/.test(navigator.userAgent) ? 'android-web' : 'desktop-web')
    subscriptionEndpoint = subscription.endpoint
    reportAlertStatus('registered', browserPlatform())
    return subscription.endpoint
  } catch (err) {
    reportAlertStatus('error', browserPlatform(), err instanceof Error ? err.message : String(err))
    console.error('Could not turn on browser alerts', err)
    subscriptionEndpoint = null
    return null
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Stops alerts for this browser, used when the worker signs out. */
export async function unregisterForPush(): Promise<void> {
  try {
    const reg = await registerServiceWorker()
    const subscription = await reg?.pushManager.getSubscription()
    if (subscription) {
      await deletePushToken(subscription.endpoint).catch(() => undefined)
      await subscription.unsubscribe()
    }
  } catch {
    // Signing out locally is enough.
  }
  subscriptionEndpoint = null
}

/** Phones in Expo Go schedule local alerts; the web app always uses server push. */
export async function syncLocalAlerts(_checks: CheckSummary[]): Promise<void> {}

/**
 * Calls back with the check id when the worker taps an alert: either the app was opened
 * from the notification (?check=<id> in the address) or it was already open.
 */
export function onNotificationTap(handler: (checkId: string) => void) {
  if (typeof window === 'undefined') return () => undefined

  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('check')
  if (fromUrl) {
    handler(fromUrl)
    params.delete('check')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  }

  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === 'open-check' && typeof event.data.checkId === 'string') handler(event.data.checkId)
  }
  navigator.serviceWorker?.addEventListener('message', onMessage)
  return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
}

/** Why alerts cannot be turned on in this browser, for the Profile screen. */
export function alertHelp(): string | null {
  switch (webAlertSupport()) {
    case 'ios-needs-home-screen':
      return 'On iPhone, alerts work from the Home Screen app: tap Share, then "Add to Home Screen", open Quality Worker from the Home Screen and turn on alerts there.'
    case 'insecure':
      return 'Alerts need the secure address of this app (starting with https://). Ask your supervisor for it.'
    case 'unsupported':
      return 'This browser cannot show alerts. Use Chrome, Edge or Safari.'
    default:
      return typeof Notification !== 'undefined' && Notification.permission === 'denied'
        ? 'Alerts are blocked for this site. Allow notifications in the browser settings, then try again.'
        : null
  }
}
