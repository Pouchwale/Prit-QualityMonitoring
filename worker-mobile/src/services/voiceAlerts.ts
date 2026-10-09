import { AppState } from 'react-native'
import * as Speech from 'expo-speech'
import { File, Paths } from 'expo-file-system'
import { tokenStorage } from './storage'
import { nativeVoice } from './nativeVoice'
import type { VoiceLanguage } from '../types'
import {
  chooseVoices,
  createVoiceQueue,
  handleIncoming,
  speakSafely,
  withTimeout,
  type SpeakResult,
  type SpeechEngine,
  type VoiceAlert,
  type VoiceChoice
} from './voiceQueue'

/**
 * Voice alerts on the phone: a due check's notification is also spoken through the speaker, with the
 * phone's own text-to-speech (Indian English when the phone has it, otherwise another English voice,
 * otherwise the phone's default). Notifications themselves are not changed and stay on whatever this
 * switch says. The web app uses voiceAlerts.web.ts (no voice).
 */

export const voiceAlertsSupported = true

/**
 * App 1.2.0+: the native voice service speaks alerts (also with the app closed), Test voice uses it
 * too, and its log and last alert are shown. Without it (app 1.1.0) the JavaScript voice below is used.
 */
export const usesNativeVoice = nativeVoice !== null

const SETTING_KEY = 'voice_alerts'
/** Alerts already handled (check + due time), so none is spoken twice. */
const CLAIMS_FILE = 'voice-alerts.json'
/** How each alert went, for the Profile screen. */
const RESULTS_FILE = 'voice-alert-results.json'
/** How long a handled alert is remembered, so it is never spoken again. */
const KEEP_MS = 24 * 60 * 60 * 1000
/** How long the phone may take to list its voices before the generic choices are used. */
const VOICE_LIST_MS = 5_000
/** How long a stored value (switch, records) may take; after that the alert goes on without it. */
const STORAGE_MS = 3_000
/** The on-phone voice log: each step of each alert, for checking on the phone. */
const TRACE_FILE = 'voice-trace.json'
const TRACE_KEEP = 40

export interface VoiceTraceEntry {
  at: number
  step: string
  detail?: string
  /** The app state when it happened (active = on screen). */
  app: string
}

let traceEntries: VoiceTraceEntry[] | null = null
let traceWrite: Promise<unknown> = Promise.resolve()

/** Adds one step to the voice log (kept on the phone, newest last). Never throws, never waits. */
export function voiceTrace(step: string, detail?: string) {
  const entry: VoiceTraceEntry = { at: Date.now(), step, detail, app: AppState.currentState ?? 'unknown' }
  traceWrite = traceWrite
    .then(async () => {
      traceEntries ??= (await readJson<{ entries: VoiceTraceEntry[] }>(TRACE_FILE, { entries: [] })).entries ?? []
      traceEntries = [...traceEntries, entry].slice(-TRACE_KEEP)
      writeJson(TRACE_FILE, { entries: traceEntries })
    })
    .catch(() => undefined)
}

/**
 * The voice log, newest first, for the Profile screen: the app's own steps ("app active") and, in
 * app 1.2.0+, the native voice service's steps with the phone state ("app closed · screen off · locked").
 */
export async function voiceTraceEntries(): Promise<VoiceTraceEntry[]> {
  await traceWrite
  const own = (traceEntries ?? (await readJson<{ entries: VoiceTraceEntry[] }>(TRACE_FILE, { entries: [] })).entries ?? []).map((e) => ({ ...e, app: `app ${e.app}` }))
  let native: VoiceTraceEntry[] = []
  try {
    const list = nativeVoice ? (JSON.parse(nativeVoice.getLog()) as { at: number; step: string; detail?: string | null; state?: string }[]) : []
    native = list.map((e) => ({ at: e.at, step: e.step, detail: e.detail ?? undefined, app: e.state ?? '' }))
  } catch {
    // Only the app's own steps.
  }
  return [...own, ...native].sort((a, b) => b.at - a.at)
}

/** Voice alerts are always on (there is no switch); kept as a function for the voice service setup. */
export async function voiceAlertsEnabled(): Promise<boolean> {
  return true
}

export async function setVoiceAlertsEnabled(on: boolean): Promise<void> {
  try {
    nativeVoice?.setEnabled(on)
  } catch {
    // The stored switch below is still saved; the voice service gets it at the next start.
  }
  await tokenStorage.set(SETTING_KEY, on ? 'on' : 'off')
  if (!on) await withTimeout(Speech.stop(), 2_000, undefined)
}

// ------------------------------------------------------------------------------------- small JSON files

function readJson<T>(name: string, empty: T): Promise<T> {
  return (async () => {
    try {
      const file = new File(Paths.document, name)
      if (!file.exists) return empty
      return JSON.parse(await file.text()) as T
    } catch {
      return empty
    }
  })()
}

function writeJson(name: string, value: unknown) {
  try {
    const file = new File(Paths.document, name)
    if (!file.exists) file.create()
    file.write(JSON.stringify(value))
  } catch {
    // Only the record is lost; speaking is not affected.
  }
}

interface Claims {
  spoken: { id: string; at: number; via: string }[]
}

/** Records an alert as handled; false when it was handled already (in the last day). */
async function claim(id: string, via: string): Promise<boolean> {
  const now = Date.now()
  const log = await readJson<Claims>(CLAIMS_FILE, { spoken: [] })
  const handled = (Array.isArray(log.spoken) ? log.spoken : []).filter((s) => now - s.at < KEEP_MS)
  if (handled.some((s) => s.id === id)) return false
  handled.push({ id, at: now, via })
  writeJson(CLAIMS_FILE, { spoken: handled.slice(-200) })
  return true
}

/** How a real alert went. */
export interface VoiceAlertResult {
  at: number
  via: string
  ok: boolean
  /** The voice used, or why nothing was spoken. */
  detail: string
}

async function record(id: string, via: string, result: SpeakResult) {
  const results = await readJson<{ results: (VoiceAlertResult & { id: string })[] }>(RESULTS_FILE, { results: [] })
  const list = Array.isArray(results.results) ? results.results : []
  list.push({ id, at: Date.now(), via, ok: result.ok, detail: result.ok ? result.voice : result.reason })
  writeJson(RESULTS_FILE, { results: list.slice(-20) })
}

/** The last real alert and how it went (spoken, or why not), for the Profile screen. */
export async function lastVoiceAlert(): Promise<VoiceAlertResult | null> {
  if (nativeVoice) {
    try {
      const last = nativeVoice.getLastAlert()
      return last ? (JSON.parse(last) as VoiceAlertResult) : null
    } catch {
      return null
    }
  }
  const list = (await readJson<{ results: VoiceAlertResult[] }>(RESULTS_FILE, { results: [] })).results
  return Array.isArray(list) && list.length ? list[list.length - 1] : null
}

// ------------------------------------------------------------------------------------- speaking

/** expo-speech as the queue uses it. */
const engine: SpeechEngine = {
  speak: (text, options) => Speech.speak(text, options),
  stop: () => Speech.stop(),
  isSpeaking: () => Speech.isSpeakingAsync()
}

/**
 * The voices to try, from the phone's own list (looked up once it answers; a phone whose speech engine
 * does not answer gets the generic English / default choices, and is asked again next time).
 */
let cachedChoices: VoiceChoice[] | null = null
async function voiceChoices(): Promise<VoiceChoice[]> {
  if (cachedChoices) return cachedChoices
  const voices = await withTimeout(Speech.getAvailableVoicesAsync(), VOICE_LIST_MS, [])
  const choices = chooseVoices(voices)
  if (voices.length) cachedChoices = choices
  return choices
}

/** The one speech function, for real alerts and Test voice alike. */
const speak = async (text: string, onStart?: (voice: string) => void): Promise<SpeakResult> =>
  speakSafely(engine, text, await voiceChoices(), undefined, onStart)

/**
 * The stored "already spoken" record: if it cannot be read or written in time, the alert is still
 * spoken (in this session it is still only spoken once).
 */
const claimInTime = (id: string, via: string) =>
  withTimeout(
    claim(id, via).catch(() => true),
    STORAGE_MS,
    true
  )

const queue = createVoiceQueue({
  enabled: voiceAlertsEnabled,
  claim: claimInTime,
  speak,
  record: (id, via, result) => withTimeout(record(id, via, result), STORAGE_MS, undefined),
  trace: voiceTrace
})

/**
 * Speaks an alert once, after any voice already speaking. `via` says where it came from ("app open",
 * or the background task with the app state), for the Profile screen.
 */
export function announceVoiceAlert(alert: VoiceAlert, via: string): Promise<boolean> {
  return queue.announce(alert, via)
}

/**
 * A notification arrived (services/voiceTask.ts: open-app listener or background task) with this
 * data: its voice text is queued, and each step is written to the voice log.
 */
export function handleNotificationData(data: unknown, via: string): Promise<boolean> {
  return handleIncoming(data, via, announceVoiceAlert, voiceTrace)
}

/** The Test voice sample in each language (alerts themselves are written by the server). */
const TEST_TEXTS: Record<VoiceLanguage, string> = {
  en: 'This is a test voice alert. When a check is due, the phone will say what to check and how many minutes you have.',
  hi: 'यह एक टेस्ट वॉइस अलर्ट है। जब कोई जाँच होनी होगी, तो फ़ोन बताएगा कि क्या जाँचना है और आपके पास कितने मिनट हैं।',
  gu: 'આ એક ટેસ્ટ વૉઇસ એલર્ટ છે. જ્યારે કોઈ તપાસ કરવાની હશે, ત્યારે ફોન કહેશે કે શું તપાસવાનું છે અને તમારી પાસે કેટલી મિનિટ છે.'
}
const TEST_TEXT = TEST_TEXTS.en

/**
 * Profile → Test voice: says a sample with the same voice choice and time limits as real alerts, in
 * the same queue (so it never talks over an alert), but outside the alert rules: it is not remembered
 * as an alert and does not count as "Last voice alert".
 */
export async function testVoice(language: VoiceLanguage = 'en'): Promise<SpeakResult> {
  if (nativeVoice) {
    // The native voice service: the same voice choice, alarm stream and service that speak real alerts.
    const answer = await withTimeout(
      nativeVoice.testVoice(TEST_TEXTS[language], language, language === 'en' ? null : TEST_TEXT),
      80_000,
      JSON.stringify({ ok: false, detail: 'the voice took too long' })
    )
    try {
      const { ok, detail } = JSON.parse(answer) as { ok: boolean; detail: string }
      return ok ? { ok: true, voice: detail } : { ok: false, reason: detail }
    } catch {
      return { ok: false, reason: 'the voice service gave no answer' }
    }
  }
  return queue.exclusive(TEST_TEXT)
}
