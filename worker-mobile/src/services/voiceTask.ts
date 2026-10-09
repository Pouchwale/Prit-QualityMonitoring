import { AppState } from 'react-native'
import * as TaskManager from 'expo-task-manager'
import * as Notifications from 'expo-notifications'
import { handleNotificationData } from './voiceAlerts'
import { nativeVoice } from './nativeVoice'

/**
 * What makes a notification speak. Both triggers are set up here, the first thing App.tsx loads, so
 * they exist before any screen opens and are never removed by navigation:
 *
 *  - App open: expo-notifications calls this listener for every notification that arrives while the
 *    app is in front (it parses the data into `content.data`).
 *  - Background task: expo-notifications also runs this task when a notification reaches the app's
 *    own message handler. With the app in the background, Android normally shows our notifications
 *    itself without running app code, so this then usually does not run.
 *
 * Each alert is spoken once, whichever trigger gets it first; every step is written to the voice log
 * (Profile → Voice alerts). The notification itself is never changed here.
 */
export const VOICE_ALERT_TASK = 'quality-voice-alerts'

// The whole notification is passed on: the voice text is searched for wherever it arrived.
Notifications.addNotificationReceivedListener((notification) => {
  // App 1.2.0+: the native voice service already speaks it (see modules/voice-alerts).
  if (nativeVoice) return
  handleNotificationData(notification, 'app open').catch(() => undefined)
})

TaskManager.defineTask(VOICE_ALERT_TASK, async ({ data }) => {
  // A tap on a notification also arrives here; it is not a new alert.
  if (data && typeof data === 'object' && 'actionIdentifier' in data) return Notifications.BackgroundNotificationTaskResult.NoData
  await handleNotificationData(data, `background task (app ${AppState.currentState ?? 'not running'})`).catch(() => undefined)
  return Notifications.BackgroundNotificationTaskResult.NoData
})

if (nativeVoice) {
  // Not needed with the native voice service: a JavaScript task would start the app's code for every push.
  Notifications.unregisterTaskAsync(VOICE_ALERT_TASK).catch(() => undefined)
} else {
  Notifications.registerTaskAsync(VOICE_ALERT_TASK).catch((err) => console.warn('Could not register the voice alert task', err))
}
