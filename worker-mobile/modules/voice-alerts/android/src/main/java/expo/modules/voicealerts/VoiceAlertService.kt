package expo.modules.voicealerts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import androidx.core.app.NotificationCompat
import java.util.ArrayDeque
import java.util.Locale

/**
 * Speaks voice alerts with Android text-to-speech on the alarm audio stream, one at a time, then
 * stops. It runs as a foreground service (Android shows a small "Speaking…" notification meanwhile)
 * and keeps the phone awake while speaking, so it also works with the app closed, the phone locked and
 * the screen off. Every step has a time limit; a failed alert never blocks the next one.
 */
class VoiceAlertService : Service(), TextToSpeech.OnInitListener {
  companion object {
    const val EXTRA_ID = "id"
    const val EXTRA_TEXT = "text"
    const val EXTRA_TEST = "test"
    const val EXTRA_LANGUAGE = "language"
    const val EXTRA_FALLBACK = "fallback"
    private const val CHANNEL = "voice-alert-speaking"
    private const val NOTIFICATION_ID = 7342
    private const val INIT_LIMIT_MS = 10_000L
    private const val START_LIMIT_MS = 10_000L
    private const val WAKE_LOCK_MS = 3L * 60 * 1000
  }

  private data class Item(val id: String, val text: String, val test: Boolean, val language: String, val fallbackText: String?)

  private val handler = Handler(Looper.getMainLooper())
  private val queue = ArrayDeque<Item>()
  private var tts: TextToSpeech? = null
  private var ready = false
  private var current: Item? = null
  private var started = false
  private var voiceLabel = "phone default voice"
  /** The text being spoken now (the alert's, or its English fallback), for its time limit. */
  private var spokenText = ""
  private var wakeLock: PowerManager.WakeLock? = null
  /** An AudioFocusRequest on Android 8+ (kept as Any so older phones never load the class). */
  private var focusRequest: Any? = null
  private var lastStartId = 0

  private val alarmAttributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  private val limitReached = Runnable { onLimitReached() }
  private val initLimitReached = Runnable { onInitFailed("the phone voice engine did not respond") }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    if (!goForeground()) return START_NOT_STICKY
    acquireWakeLock()
    val id = intent?.getStringExtra(EXTRA_ID)
    val text = intent?.getStringExtra(EXTRA_TEXT)
    if (id != null && text != null) {
      queue.addLast(
        Item(
          id,
          text,
          intent?.getBooleanExtra(EXTRA_TEST, false) == true,
          intent?.getStringExtra(EXTRA_LANGUAGE) ?: "en",
          intent?.getStringExtra(EXTRA_FALLBACK)
        )
      )
    }
    if (tts == null) {
      tts = TextToSpeech(applicationContext, this)
      handler.postDelayed(initLimitReached, INIT_LIMIT_MS)
    } else if (ready) {
      next()
    }
    return START_NOT_STICKY
  }

  /** Runs as a foreground service (required to speak from the background); false when Android refuses. */
  private fun goForeground(): Boolean {
    return try {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
        val channel = NotificationChannel(CHANNEL, "Voice alerts", NotificationManager.IMPORTANCE_LOW)
        channel.setSound(null, null)
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      val icon = resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 } ?: applicationInfo.icon
      val notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(icon)
        .setContentTitle("Quality alert")
        .setContentText("Speaking the quality check alert…")
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setSilent(true)
        .build()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      true
    } catch (e: Exception) {
      val items = drain()
      items.forEach { VoiceAlertCenter.finished(this, it.id, it.test, false, "Android did not let the voice run (${e.javaClass.simpleName})") }
      stopSelf()
      false
    }
  }

  private fun acquireWakeLock() {
    try {
      if (wakeLock == null) {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "QualityWorker:voiceAlert").apply { setReferenceCounted(false) }
      }
      wakeLock?.acquire(WAKE_LOCK_MS)
    } catch (e: Exception) {
      // Speaking is still tried.
    }
  }

  override fun onInit(status: Int) {
    handler.post {
      handler.removeCallbacks(initLimitReached)
      val engine = tts
      if (engine == null) return@post
      if (status != TextToSpeech.SUCCESS) {
        onInitFailed("the phone voice engine reported an error")
        return@post
      }
      configure(engine)
      ready = true
      next()
    }
  }

  /** Alarm stream, speech rate and progress listener; the voice is chosen per alert (useLanguage). */
  private fun configure(engine: TextToSpeech) {
    try {
      engine.setAudioAttributes(alarmAttributes)
    } catch (e: Exception) {
      // Older engines: the stream is also passed with each text.
    }
    engine.setSpeechRate(0.9f)
    engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {
        handler.post { onSpeechStart(utteranceId) }
      }

      override fun onDone(utteranceId: String?) {
        handler.post { onSpeechEnd(utteranceId, true, null) }
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        handler.post { onSpeechEnd(utteranceId, false, "the phone voice engine reported an error") }
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        handler.post { onSpeechEnd(utteranceId, false, "the phone voice engine reported an error ($errorCode)") }
      }

      override fun onStop(utteranceId: String?, interrupted: Boolean) {
        handler.post { onSpeechEnd(utteranceId, false, "the voice was stopped") }
      }
    })
  }

  /**
   * Sets the voice for a language (en, hi, gu): an installed voice of that language, India first,
   * on-device first; otherwise the engine's own voice for it. Returns its name, or null when the phone
   * has no voice for the language.
   */
  private fun useLanguage(engine: TextToSpeech, language: String): String? {
    val name = when (language) {
      "hi" -> "Hindi"
      "gu" -> "Gujarati"
      else -> "English"
    }
    val voices = try {
      engine.voices?.toList() ?: emptyList()
    } catch (e: Exception) {
      emptyList()
    }
    val best = voices
      .filter { it.locale.language == language && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
      .sortedWith(compareBy<Voice>({ if (it.locale.country == "IN") 0 else 1 }, { if (it.isNetworkConnectionRequired) 1 else 0 }))
      .firstOrNull()
    if (best != null && engine.setVoice(best) == TextToSpeech.SUCCESS) {
      return if (best.locale.country == "IN") "$name (India)" else "$name (${best.locale.toLanguageTag()})"
    }
    val locale = if (language == "en") Locale.ENGLISH else Locale(language, "IN")
    return if (engine.setLanguage(locale) >= TextToSpeech.LANG_AVAILABLE) name else null
  }

  /** Speaks the next queued alert, if nothing is speaking; stops the service when the queue is empty. */
  private fun next() {
    if (current != null || !ready) return
    val item = queue.pollFirst()
    if (item == null) {
      finishAll()
      return
    }
    current = item
    started = false
    acquireWakeLock()
    requestFocus()
    // The alert's language; without a voice for it, its English text in English.
    val engine = tts
    var text = item.text
    var label = engine?.let { useLanguage(it, item.language) }
    if (label == null && item.language != "en" && item.fallbackText != null && engine != null) {
      VoiceAlertCenter.log(this, "no ${item.language} voice on this phone, speaking English", item.id)
      text = item.fallbackText ?: item.text
      label = useLanguage(engine, "en")
    }
    voiceLabel = label ?: "phone default voice"
    spokenText = text
    val params = Bundle()
    params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_ALARM)
    val result = try {
      engine?.speak(text, TextToSpeech.QUEUE_FLUSH, params, item.id) ?: TextToSpeech.ERROR
    } catch (e: Exception) {
      TextToSpeech.ERROR
    }
    if (result != TextToSpeech.SUCCESS) {
      complete(false, "the phone voice engine reported an error")
      return
    }
    handler.postDelayed(limitReached, START_LIMIT_MS)
  }

  private fun finishLimit(text: String): Long = minOf(60_000L, 8_000L + text.length * 110L)

  private fun onSpeechStart(utteranceId: String?) {
    val item = current ?: return
    if (utteranceId != item.id || started) return
    started = true
    handler.removeCallbacks(limitReached)
    handler.postDelayed(limitReached, finishLimit(spokenText))
    VoiceAlertCenter.log(this, if (item.test) "test voice started" else "speech started", voiceLabel)
  }

  private fun onSpeechEnd(utteranceId: String?, ok: Boolean, reason: String?) {
    val item = current ?: return
    if (utteranceId != item.id) return
    complete(ok, reason)
  }

  /** A time limit passed: give a quiet engine its finish time if it is speaking anyway, else stop this one. */
  private fun onLimitReached() {
    val item = current ?: return
    if (!started && tts?.isSpeaking == true) {
      started = true
      handler.postDelayed(limitReached, finishLimit(spokenText))
      return
    }
    try {
      tts?.stop()
    } catch (e: Exception) {
      // Moving on regardless.
    }
    complete(false, if (started) "the voice did not finish in time" else "the phone voice engine did not respond")
  }

  private fun complete(ok: Boolean, reason: String?) {
    handler.removeCallbacks(limitReached)
    val item = current ?: return
    current = null
    VoiceAlertCenter.finished(this, item.id, item.test, ok, if (ok) voiceLabel else (reason ?: "not spoken"))
    abandonFocus()
    next()
  }

  private fun onInitFailed(reason: String) {
    handler.removeCallbacks(initLimitReached)
    try {
      tts?.shutdown()
    } catch (e: Exception) {
      // Gone anyway.
    }
    tts = null
    ready = false
    drain().forEach { VoiceAlertCenter.finished(this, it.id, it.test, false, reason) }
    finishAll()
  }

  /** Everything still to speak, emptied. */
  private fun drain(): List<Item> {
    val items = mutableListOf<Item>()
    current?.let { items.add(it) }
    current = null
    items.addAll(queue)
    queue.clear()
    return items
  }

  private fun requestFocus() {
    try {
      val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(alarmAttributes).build()
        focusRequest = request
        audio.requestAudioFocus(request)
      } else {
        @Suppress("DEPRECATION")
        audio.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      }
    } catch (e: Exception) {
      // Spoken without focus.
    }
  }

  private fun abandonFocus() {
    try {
      val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        (focusRequest as? AudioFocusRequest)?.let { audio.abandonAudioFocusRequest(it) }
      } else {
        @Suppress("DEPRECATION")
        audio.abandonAudioFocus(null)
      }
    } catch (e: Exception) {
      // Nothing to release.
    }
    focusRequest = null
  }

  /** Nothing left to say: release everything and stop (unless a newer alert arrived meanwhile). */
  private fun finishAll() {
    abandonFocus()
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (e: Exception) {
      // Released by its timeout.
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(Service.STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelfResult(lastStartId)
  }

  override fun onDestroy() {
    handler.removeCallbacks(limitReached)
    handler.removeCallbacks(initLimitReached)
    try {
      tts?.stop()
      tts?.shutdown()
    } catch (e: Exception) {
      // Done.
    }
    tts = null
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (e: Exception) {
      // Released by its timeout.
    }
    super.onDestroy()
  }
}
