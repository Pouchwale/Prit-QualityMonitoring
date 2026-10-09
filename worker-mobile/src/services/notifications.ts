import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { CheckSummary } from '../types'
import {
  ApiError,
  deletePushToken,
  getApiUrl,
  getTodayChecks,
  registerPushToken,
  rememberUnremovedPushToken,
  reportAlertStatus,
  type AlertStatus
} from './api'
import { nativeVoice } from './nativeVoice'

/**
 * "Check is due" alerts on the phone.
 *
 * Real builds (APK / app bundle): the phone registers an Expo push token, which is backed
 * by a Firebase (FCM) device token, and the backend sends the alert. It arrives in the
 * notification panel with the app closed or the phone locked, like any other app.
 *
 * Expo Go cannot receive server push, so there the app falls back to scheduling the same
 * alerts locally. That is for development only; the shipped APK always uses server push.
 *
 * Either way the check list comes from the server and only holds the worker's assigned
 * machines, so alerts follow the admin's machine assignment.
 */

const CHANNEL_ID = 'due-checks'
/** Local alerts are scheduled this far ahead, and iOS allows only a limited number. */
const LOCAL_WINDOW_HOURS = 24
const MAX_LOCAL = 30

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
})

let pushToken: string | null = null
let permissionGranted: boolean | null = null
/** Why the last registration did not work, in words for the worker (null when it worked). */
let lastProblem: string | null = null

const devicePlatform = () => `${Platform.OS}${isExpoGo ? ' (Expo Go)' : ''} · ${Device.modelName ?? 'phone'}`

function setOutcome(status: AlertStatus, problem: string | null, detail?: string) {
  lastProblem = problem
  reportAlertStatus(status, devicePlatform(), detail)
}

/** Expo Go cannot receive server push; a real build can. */
export const isExpoGo = Constants.executionEnvironment === 'storeClient'

export const usesServerPush = () => pushToken !== null
export const getPushToken = () => pushToken

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Quality checks',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default'
  })
}

/** Asks for permission once. Returns true when alerts are allowed. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!Device.isDevice) {
    permissionGranted = false
    return false
  }
  await ensureAndroidChannel()
  const current = await Notifications.getPermissionsAsync()
  const status = current.granted ? current : await Notifications.requestPermissionsAsync()
  permissionGranted = status.granted
  return status.granted
}

export async function notificationsAllowed(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted
  const status = await Notifications.getPermissionsAsync()
  permissionGranted = status.granted
  return status.granted
}

/**
 * Registers this phone for server-sent notifications. Returns the token, or null when
 * the build cannot receive them (Expo Go).
 */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null
  if (!(await notificationsAllowed())) {
    pushToken = null
    setOutcome('permission-denied', 'Notifications are not allowed for this app. Allow them in the phone Settings.')
    return null
  }
  await ensureAndroidChannel()

  // Expo issues push tokens per project; without a project id (set by `npx eas-cli init`) it refuses.
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
  if (!projectId) {
    pushToken = null
    setOutcome(
      'no-project-id',
      'This app is not set up for notifications yet. Ask your supervisor.',
      isExpoGo ? 'Expo Go: the project has no EAS project id' : 'App build without an EAS project id'
    )
    console.warn('No EAS project id: run "npx eas-cli init" in worker-mobile, otherwise this phone cannot get notifications')
    return null
  }

  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId })
    pushToken = data
    // App 1.2.0+ on Android: also the phone's own Firebase token, so due-check alerts can come as
    // Firebase data messages that the native voice service speaks with the app closed.
    let fcmToken: string | undefined
    if (nativeVoice && Platform.OS === 'android') {
      try {
        const device = await Notifications.getDevicePushTokenAsync()
        if (typeof device.data === 'string' && device.data) fcmToken = device.data
      } catch (err) {
        console.warn('No Firebase token: alerts come through Expo', err)
      }
    }
    await registerPushToken(data, devicePlatform(), fcmToken)
    try {
      nativeVoice?.configure(getApiUrl() || null, fcmToken ?? null, true)
    } catch (err) {
      console.warn('Could not set up the voice service', err)
    }
    setOutcome('registered', null)
    return data
  } catch (err) {
    pushToken = null
    const message = err instanceof Error ? err.message : String(err)
    if (isExpoGo && Platform.OS === 'android') {
      setOutcome('expo-go-unsupported', 'Expo Go on Android cannot receive notifications. Install the Quality Worker app.', message)
    } else {
      setOutcome('error', 'This phone could not be registered for notifications. Try again later.', message)
    }
    console.error('Could not register this phone for notifications', err)
    return null
  }
}

/**
 * Signing out: the server stops sending this phone the worker's alerts, and pending alerts are
 * cleared. When the server cannot be reached, the token is remembered and the sign-out is finished
 * on the next start (api.ts logout).
 *
 * `keepShiftReminders` (workers): the server keeps the phone registered for the worker's
 * shift-start login reminder only, so the voice service stays set up to speak that reminder.
 */
export async function unregisterForPush(options: { keepShiftReminders?: boolean } = {}): Promise<void> {
  const token = pushToken
  if (options.keepShiftReminders) await endShiftLocally()
  else await stopAlertsLocally()
  if (!token) return
  try {
    await deletePushToken(token)
  } catch (err) {
    // A 401 means the sign-in is already over; anything else (offline, server trouble) is retried.
    if (!(err instanceof ApiError && (err.status === 401 || err.status === 403))) rememberUnremovedPushToken(token)
  }
}

/**
 * Stops this phone's alerts for the signed-out worker without asking the server (also used when
 * the session expired and the server no longer accepts this sign-in): the native voice service
 * stops speaking and sending its log for that worker, and scheduled reminders are removed.
 */
export async function stopAlertsLocally(): Promise<void> {
  pushToken = null
  try {
    nativeVoice?.configure(getApiUrl() || null, null, false)
  } catch (err) {
    console.warn('Could not stop the voice service', err)
  }
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined)
}

/**
 * The worker's shift ended (or they signed out): scheduled check reminders are removed, but the
 * voice service stays set up, so the next shift's login reminder is still spoken. The server only
 * sends that reminder to a signed-out phone, never check alerts.
 */
export async function endShiftLocally(): Promise<void> {
  pushToken = null
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined)
}

/**
 * Keeps local alerts in step with the worker's checks. Called after every list refresh,
 * so an admin changing the machine assignment is reflected on the next refresh.
 */
/** Rebuilds the local reminders from the server, e.g. after a job ends or is handed over. */
export function resyncLocalAlerts() {
  getTodayChecks()
    .then(syncLocalAlerts)
    .catch(() => undefined)
}

export async function syncLocalAlerts(checks: CheckSummary[]): Promise<void> {
  // Development only: a real build always receives alerts from the backend.
  if (!isExpoGo || usesServerPush()) return
  if (!(await notificationsAllowed())) return

  const now = Date.now()
  const until = now + LOCAL_WINDOW_HOURS * 60 * 60 * 1000
  const upcoming = checks
    .filter((c) => (c.status === 'PENDING' || c.status === 'DUE') && !c.submittedAt)
    .map((c) => ({ check: c, at: new Date(c.scheduledAt).getTime() }))
    .filter((c) => c.at > now + 30_000 && c.at < until)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_LOCAL)

  try {
    await ensureAndroidChannel()
    // Rebuild the list so cancelled or reassigned checks disappear.
    await Notifications.cancelAllScheduledNotificationsAsync()
    for (const { check, at } of upcoming) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Quality check due',
          body: `${check.machineName} · ${check.activityName}`,
          data: { checkId: check.id },
          sound: 'default'
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(at),
          channelId: CHANNEL_ID
        }
      })
    }
  } catch (err) {
    console.warn('Could not schedule alerts', err)
  }
}

const checkIdOf = (response: Notifications.NotificationResponse | null) => {
  const checkId = response?.notification.request.content.data?.checkId
  return typeof checkId === 'string' ? checkId : null
}

/**
 * Calls back with the check id when a worker taps an alert, including the tap that
 * started the app from the notification panel while it was closed.
 */
export function onNotificationTap(handler: (checkId: string) => void) {
  let handledColdStart = false

  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      const checkId = checkIdOf(response)
      if (checkId && !handledColdStart) {
        handledColdStart = true
        handler(checkId)
        // Handled once: signing out and in again must not open this old check a second time.
        try {
          Notifications.clearLastNotificationResponse()
        } catch {
          // Older native code: the response simply stays until the app is restarted.
        }
      }
    })
    .catch(() => undefined)

  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const checkId = checkIdOf(response)
    if (checkId) handler(checkId)
  })
  return () => sub.remove()
}

/** Web app only (see notifications.web.ts); phones have nothing to register. */
export async function registerServiceWorker(): Promise<null> {
  return null
}

/** Why alerts do not reach this phone, for the Profile screen (null when they do or it is unknown). */
export function alertHelp(): string | null {
  return lastProblem
}
