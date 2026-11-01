package expo.modules.voicealerts

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * Every Firebase message for the app arrives here first (manifest priority 10, above
 * expo-notifications' -1), also with the app closed and the phone locked when the message is a
 * high-priority data message. expo-notifications handles it exactly as before (shows the notification,
 * informs the app); then a voice alert in it is handed to the speaking service.
 */
class VoiceMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    try {
      super.onMessageReceived(remoteMessage)
    } catch (e: Exception) {
      VoiceAlertCenter.log(applicationContext, "notification handling error", e.javaClass.simpleName)
    }
    try {
      // The same message id the notification gets (expo-notifications: its "tag", else the message id).
      VoiceAlertCenter.onPush(applicationContext, remoteMessage.data, remoteMessage.data["tag"] ?: remoteMessage.messageId)
    } catch (e: Exception) {
      VoiceAlertCenter.log(applicationContext, "voice handling error", e.javaClass.simpleName)
    }
  }

  /** Firebase replaced this phone's token: expo-notifications handles it, and the voice log uses the new one. */
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    try {
      VoiceAlertCenter.onNewToken(applicationContext, token)
    } catch (e: Exception) {
      // The app registers the new token on its next start anyway.
    }
  }
}
