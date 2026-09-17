import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { CheckSummary } from '../types'
import { deletePushToken, registerPushToken, reportAlertStatus, type AlertStatus } from './api'

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
    await registerPushToken(data, devicePlatform())
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

/** Removes this phone from the backend and clears pending alerts. */
export async function unregisterForPush(): Promise<void> {
  try {
    if (pushToken) await deletePushToken(pushToken)
  } catch {
    // Signing out locally is enough.
  }
  pushToken = null
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined)
}

/**
 * Keeps local alerts in step with the worker's checks. Called after every list refresh,
 * so an admin changing the machine assignment is reflected on the next refresh.
 */
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
