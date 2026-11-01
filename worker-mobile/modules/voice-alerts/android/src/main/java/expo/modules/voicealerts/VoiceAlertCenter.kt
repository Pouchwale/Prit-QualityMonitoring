package expo.modules.voicealerts

import android.app.ActivityManager
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Voice alerts, native side: what a push needs to be spoken (its voice text, the Voice alerts switch,
 * "already spoken"), the voice log on the phone, and its copy on the server (remote voice log).
 *
 * The backend writes the spoken text (data `voice`, unique `voiceId` = check + due time); this only
 * says it, once per voiceId (remembered for a day), through VoiceAlertService.
 */
object VoiceAlertCenter {
  private const val PREFS = "quality_voice_alerts"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_API_URL = "apiUrl"
  private const val KEY_DEVICE_TOKEN = "deviceToken"
  private const val KEY_SPOKEN = "spoken"
  private const val KEY_LOG = "log"
  private const val KEY_PENDING = "pending"
  private const val KEY_LAST_ALERT = "lastAlert"
  /** The device token the server refused (401): the log is not sent again until the token changes. */
  private const val KEY_REFUSED_TOKEN = "refusedToken"
  private const val KEEP_MS = 24L * 60 * 60 * 1000
  private const val LOG_KEEP = 60
  private const val PENDING_KEEP = 200
  private const val UPLOAD_BATCH = 50
  private const val TEST_TIMEOUT_MS = 75_000L

  /** Titles of the notifications that are quality check alerts (backend services/notifications.ts). */
  private val SPOKEN_TITLES = setOf("Quality check due", "Test notification")

  private val lock = Any()
  private val uploader = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val testCallbacks = ConcurrentHashMap<String, (Boolean, String) -> Unit>()

  /** True once the app's screens have loaded in this process; false when a push started the app. */
  @Volatile
  var appUiLoaded = false

  /**
   * One alert to speak: [text] in [language] (en, hi, gu); [fallbackText] is the English text, spoken
   * instead when the phone has no voice for that language.
   */
  data class Alert(val id: String, val text: String, val altId: String?, val language: String = "en", val fallbackText: String? = null)

  private val LANGUAGES = setOf("en", "hi", "gu")

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ------------------------------------------------------------------------------------ settings

  /**
   * Called after the app registered this phone with the server (and with nulls and false at sign
   * out). A fresh registration may make a refused token valid again, so the log is tried again.
   */
  fun configure(context: Context, apiUrl: String?, deviceToken: String?, enabled: Boolean) {
    prefs(context).edit()
      .putString(KEY_API_URL, apiUrl?.trimEnd('/'))
      .putString(KEY_DEVICE_TOKEN, deviceToken)
      .putBoolean(KEY_ENABLED, enabled)
      .remove(KEY_REFUSED_TOKEN)
      .apply()
    scheduleUpload(context)
  }

  /**
   * Firebase gave this phone a new token (VoiceMessagingService.onNewToken). Only when someone is
   * signed in: the log is then sent with the new token, which the app registers on its next start.
   */
  fun onNewToken(context: Context, token: String) {
    val p = prefs(context)
    if (p.getString(KEY_DEVICE_TOKEN, null) == null) return
    p.edit().putString(KEY_DEVICE_TOKEN, token).apply()
    scheduleUpload(context)
  }

  fun setEnabled(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
  }

  fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, true)

  // ------------------------------------------------------------------------------------ incoming push

  /**
   * The voice text of a push: our data (`voice`, `voiceId`) arrives JSON-encoded in the `body` data
   * field (both our Firebase messages and Expo's), or as separate fields. A quality check alert with
   * no voice text is spoken from its own title and text.
   */
  fun alertFrom(data: Map<String, String>, messageId: String?): Alert? {
    val body = data["body"]?.let {
      try {
        JSONObject(it)
      } catch (e: Exception) {
        null
      }
    }
    val voice = body?.optString("voice")?.takeIf { it.isNotBlank() && it != "null" } ?: data["voice"]?.takeIf { it.isNotBlank() }
    val voiceId = body?.optString("voiceId")?.takeIf { it.isNotBlank() && it != "null" } ?: data["voiceId"]?.takeIf { it.isNotBlank() }
    val altId = messageId?.let { "msg:$it" }
    // The worker's language (backend: users.voice_notification_language): the text in that language,
    // with the English text kept as the fallback.
    val language = (body?.optString("voiceLanguage")?.takeIf { it.isNotBlank() && it != "null" } ?: data["voiceLanguage"])?.takeIf { it in LANGUAGES } ?: "en"
    val local = body?.optString("voiceLocal")?.takeIf { it.isNotBlank() && it != "null" } ?: data["voiceLocal"]?.takeIf { it.isNotBlank() }
    if (voice != null && voiceId != null) {
      return if (language != "en" && local != null) Alert(voiceId, local.trim(), altId, language, voice.trim()) else Alert(voiceId, voice.trim(), altId)
    }
    val title = data["title"]
    if (title != null && title in SPOKEN_TITLES && altId != null) {
      val text = "$title. ${(data["message"] ?: "").replace(Regex("\\s*·\\s*"), ", ")}".trim().trimEnd('.', ',') + "."
      return Alert(altId, text, null)
    }
    return null
  }

  /** A push arrived (VoiceMessagingService): speak it if it is a voice alert not spoken yet. */
  fun onPush(context: Context, data: Map<String, String>, messageId: String?) {
    val alert = alertFrom(data, messageId)
    if (alert == null) {
      if (data.containsKey("title") || data.containsKey("body")) log(context, "push received, no voice text", "fields: ${data.keys.sorted().joinToString(", ")}")
      return
    }
    log(context, "push received", alert.id)
    if (!isEnabled(context)) {
      log(context, "skipped: Voice alerts is off", alert.id)
      return
    }
    if (!claim(context, listOfNotNull(alert.id, alert.altId))) {
      log(context, "skipped: already spoken", alert.id)
      return
    }
    start(context, alert.id, alert.text, false, alert.language, alert.fallbackText)
  }

  /** Profile → Test voice: the same speaking service and voice, outside the alert rules. */
  fun test(context: Context, text: String, language: String, fallbackText: String?, callback: (Boolean, String) -> Unit) {
    val id = "test:${System.currentTimeMillis()}"
    testCallbacks[id] = callback
    mainHandler.postDelayed({ testCallbacks.remove(id)?.invoke(false, "the voice took too long") }, TEST_TIMEOUT_MS)
    log(context, "test voice requested", language)
    start(context, id, text, true, language.takeIf { it in LANGUAGES } ?: "en", fallbackText)
  }

  private fun start(context: Context, id: String, text: String, test: Boolean, language: String, fallbackText: String?) {
    val intent = Intent(context, VoiceAlertService::class.java)
      .putExtra(VoiceAlertService.EXTRA_ID, id)
      .putExtra(VoiceAlertService.EXTRA_TEXT, text)
      .putExtra(VoiceAlertService.EXTRA_TEST, test)
      .putExtra(VoiceAlertService.EXTRA_LANGUAGE, language)
      .putExtra(VoiceAlertService.EXTRA_FALLBACK, fallbackText)
    try {
      ContextCompat.startForegroundService(context, intent)
      log(context, if (test) "test voice: speaking service started" else "speaking service started", id)
    } catch (e: Exception) {
      finished(context, id, test, false, "the speaking service could not start (${e.javaClass.simpleName})")
    }
  }

  /** Records an alert (all its ids) as spoken; false when one of them already was, in the last day. */
  private fun claim(context: Context, ids: List<String>): Boolean = synchronized(lock) {
    val p = prefs(context)
    val now = System.currentTimeMillis()
    val spoken = try {
      JSONObject(p.getString(KEY_SPOKEN, "{}") ?: "{}")
    } catch (e: Exception) {
      JSONObject()
    }
    val keys = mutableListOf<String>()
    spoken.keys().forEach { keys.add(it) }
    keys.filter { now - spoken.optLong(it) > KEEP_MS }.forEach { spoken.remove(it) }
    if (ids.any { spoken.has(it) }) {
      p.edit().putString(KEY_SPOKEN, spoken.toString()).commit()
      return@synchronized false
    }
    ids.forEach { spoken.put(it, now) }
    p.edit().putString(KEY_SPOKEN, spoken.toString()).commit()
    true
  }

  /** The speaking service finished one item: log it, keep "Last voice alert", answer Test voice. */
  fun finished(context: Context, id: String, test: Boolean, ok: Boolean, detail: String) {
    log(context, (if (test) "test voice " else "") + (if (ok) "spoken" else "not spoken"), detail)
    if (!test) {
      val last = JSONObject().put("at", System.currentTimeMillis()).put("via", state(context)).put("ok", ok).put("detail", detail)
      prefs(context).edit().putString(KEY_LAST_ALERT, last.toString()).apply()
    }
    testCallbacks.remove(id)?.invoke(ok, detail)
  }

  // ------------------------------------------------------------------------------------ log

  /** The phone's state now: app open / in background / closed, screen on/off, locked/unlocked. */
  fun state(context: Context): String {
    val app = try {
      val info = ActivityManager.RunningAppProcessInfo()
      ActivityManager.getMyMemoryState(info)
      when {
        !appUiLoaded -> "app closed"
        info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND -> "app open"
        else -> "app in background"
      }
    } catch (e: Exception) {
      "app ?"
    }
    val screen = try {
      if ((context.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive) "screen on" else "screen off"
    } catch (e: Exception) {
      "screen ?"
    }
    val locked = try {
      if ((context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) "locked" else "unlocked"
    } catch (e: Exception) {
      "lock ?"
    }
    return "$app · $screen · $locked"
  }

  /** Adds one step to the voice log (kept on the phone) and sends it to the server log. */
  fun log(context: Context, step: String, detail: String?) {
    try {
      val entry = JSONObject()
        .put("at", System.currentTimeMillis())
        .put("step", step)
        .put("detail", detail ?: JSONObject.NULL)
        .put("state", state(context))
      synchronized(lock) {
        val p = prefs(context)
        val log = appendCapped(p.getString(KEY_LOG, "[]"), entry, LOG_KEEP)
        val pending = appendCapped(p.getString(KEY_PENDING, "[]"), entry, PENDING_KEEP)
        p.edit().putString(KEY_LOG, log).putString(KEY_PENDING, pending).apply()
      }
      scheduleUpload(context)
    } catch (e: Exception) {
      // The log never stops a voice.
    }
  }

  private fun appendCapped(json: String?, entry: JSONObject, keep: Int): String {
    val list = try {
      JSONArray(json ?: "[]")
    } catch (e: Exception) {
      JSONArray()
    }
    list.put(entry)
    val out = JSONArray()
    val from = maxOf(0, list.length() - keep)
    for (i in from until list.length()) out.put(list.get(i))
    return out.toString()
  }

  fun logJson(context: Context): String = prefs(context).getString(KEY_LOG, "[]") ?: "[]"

  fun lastAlertJson(context: Context): String? = prefs(context).getString(KEY_LAST_ALERT, null)

  /** Sends the log lines not sent yet to the server (one request at a time, in the background). */
  fun scheduleUpload(context: Context) {
    val app = context.applicationContext
    uploader.execute { upload(app) }
  }

  private fun upload(context: Context) {
    val p = prefs(context)
    val apiUrl = p.getString(KEY_API_URL, null) ?: return
    val deviceToken = p.getString(KEY_DEVICE_TOKEN, null) ?: return
    // The server did not know this token: wait for a new one (or a new registration) instead of retrying.
    if (p.getString(KEY_REFUSED_TOKEN, null) == deviceToken) return
    val batch = synchronized(lock) {
      val pending = try {
        JSONArray(p.getString(KEY_PENDING, "[]") ?: "[]")
      } catch (e: Exception) {
        JSONArray()
      }
      val out = JSONArray()
      for (i in 0 until minOf(UPLOAD_BATCH, pending.length())) out.put(pending.get(i))
      out
    }
    if (batch.length() == 0) return
    try {
      val connection = URL("$apiUrl/api/device/voice-events").openConnection() as HttpURLConnection
      connection.requestMethod = "POST"
      connection.connectTimeout = 5_000
      connection.readTimeout = 5_000
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("X-Device-Token", deviceToken)
      connection.outputStream.use { it.write(JSONObject().put("entries", batch).toString().toByteArray(Charsets.UTF_8)) }
      val code = connection.responseCode
      connection.disconnect()
      if (code == 401) {
        p.edit().putString(KEY_REFUSED_TOKEN, deviceToken).apply()
        return
      }
      // Sent (or refused for good): drop exactly these lines from the queue. New lines may have been
      // added and old ones trimmed off the front meanwhile, so they are matched by content, not position.
      if (code in 200..299 || code == 400) {
        synchronized(lock) {
          val pending = try {
            JSONArray(p.getString(KEY_PENDING, "[]") ?: "[]")
          } catch (e: Exception) {
            JSONArray()
          }
          val sent = HashMap<String, Int>()
          for (i in 0 until batch.length()) {
            val key = batch.get(i).toString()
            sent[key] = (sent[key] ?: 0) + 1
          }
          val rest = JSONArray()
          for (i in 0 until pending.length()) {
            val entry = pending.get(i)
            val key = entry.toString()
            val left = sent[key] ?: 0
            if (left > 0) sent[key] = left - 1 else rest.put(entry)
          }
          p.edit().putString(KEY_PENDING, rest.toString()).apply()
          if (rest.length() > 0) scheduleUpload(context)
        }
      }
    } catch (e: Exception) {
      // Kept; sent with the next line or the next app start.
    }
  }
}
