package expo.modules.voicealerts

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * The app's side of the native voice alerts (JS: src/services/nativeVoice.ts): settings, Test voice,
 * the voice log and "Last voice alert". Alerts themselves are spoken by VoiceMessagingService and
 * VoiceAlertService without the app's screens.
 */
class VoiceAlertsModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "The app is not ready" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("VoiceAlerts")

    OnCreate {
      VoiceAlertCenter.appUiLoaded = true
    }

    /** Where to send the voice log (the server), this phone's Firebase token, and the Voice alerts switch. */
    Function("configure") { apiUrl: String?, deviceToken: String?, enabled: Boolean ->
      VoiceAlertCenter.configure(context, apiUrl, deviceToken, enabled)
    }

    Function("setEnabled") { enabled: Boolean ->
      VoiceAlertCenter.setEnabled(context, enabled)
    }

    /** The voice log as JSON: [{ at, step, detail, state }], oldest first. */
    Function("getLog") {
      VoiceAlertCenter.logJson(context)
    }

    /** The last real alert as JSON { at, via, ok, detail }, or null. */
    Function("getLastAlert") {
      VoiceAlertCenter.lastAlertJson(context)
    }

    /**
     * Says a sample the way alerts are spoken, in [language] (en, hi, gu; [fallbackText] in English when
     * the phone has no voice for it); resolves JSON { ok, detail } when done or failed.
     */
    AsyncFunction("testVoice") { text: String, language: String, fallbackText: String?, promise: Promise ->
      VoiceAlertCenter.test(context, text, language, fallbackText) { ok, detail ->
        promise.resolve(JSONObject().put("ok", ok).put("detail", detail).toString())
      }
    }
  }
}
