/**
 * Voice alerts, the part with no phone APIs (so it can be tested anywhere): reading the spoken text
 * from a notification, choosing the voice, speaking with time limits, and speaking alerts one after
 * another, each one once.
 *
 * The backend writes the text (services/notifications.ts: what is due, for which Item Code, how many
 * minutes the worker has); the app only says it.
 */

export interface VoiceAlert {
  /** Unique per alert: the check and its due time ("checkId:scheduledAt"), or a test id. */
  id: string
  text: string
  /** Other ids of the same notification (its push message id): it is spoken once, however it arrives. */
  altIds?: string[]
  /** Where the text came from, for the voice log. */
  source?: string
}

/** The voice alert in a notification's data ({ voice, voiceId }), or null when it has none. */
export function voiceAlertFrom(data: unknown): VoiceAlert | null {
  if (!data || typeof data !== 'object') return null
  const { voice, voiceId } = data as Record<string, unknown>
  if (typeof voice !== 'string' || !voice.trim() || typeof voiceId !== 'string' || !voiceId) return null
  return { id: voiceId, text: voice.trim() }
}

/**
 * The notification data as the background notification task receives it: on Android the data is a
 * JSON string (`data.dataString`). A tap on a notification (it has an `actionIdentifier`) is no alert.
 */
export function taskPayloadData(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || 'actionIdentifier' in payload) return null
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const text = (data as { dataString?: unknown }).dataString
  if (typeof text !== 'string') return data
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ------------------------------------------------------------------------------------- finding the voice text

/**
 * The containers expo-notifications may put our data in, depending on how the notification arrived:
 * the open-app listener gets `request.content.data` (or `dataString` / a raw `body` JSON text), the
 * background task gets the whole push message (`data.dataString`, `data.body`, or the fields
 * flattened into `data`), and a task started later gets it under `notification`.
 */
const CONTAINERS = ['data', 'dataString', 'body', 'content', 'request', 'notification', 'remoteMessage', 'payload'] as const

/** Searches a notification however it is shaped for { voice, voiceId } (JSON text is opened too). */
export function findVoiceAlert(value: unknown, depth = 0): VoiceAlert | null {
  if (depth > 6 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('{')) return null
    try {
      return findVoiceAlert(JSON.parse(text), depth + 1)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object') return null
  const direct = voiceAlertFrom(value)
  if (direct) return direct
  for (const key of CONTAINERS) {
    if (key in (value as object)) {
      const found = findVoiceAlert((value as Record<string, unknown>)[key], depth + 1)
      if (found) return found
    }
  }
  return null
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/**
 * The push message id of a notification, the same from both triggers: the listener's
 * `request.identifier` is the message's "tag", else its message id; the task gets the message itself.
 */
export function messageIdOf(value: unknown): string | null {
  const v = obj(value)
  const request = obj(v.request)
  if (str(request.identifier)) return str(request.identifier)
  const data = obj(v.data)
  return str(data.tag) ?? str(v.messageId) ?? null
}

/** Titles of the notifications that are quality check alerts (backend services/notifications.ts). */
const SPOKEN_TITLES = ['Quality check due', 'Test notification']

/**
 * When a notification carries no voice text at all: a quality check alert is still spoken, from its
 * own title and text ("Quality check due. AKO 320, Job PO-1001, Registration, print pressure.").
 * Other notifications (handover and so on) are not spoken.
 */
export function fallbackVoiceAlert(value: unknown): VoiceAlert | null {
  const v = obj(value)
  const content = obj(obj(v.request).content)
  const notification = obj(v.notification)
  const data = obj(v.data)
  const title = str(content.title) ?? str(notification.title) ?? str(data.title)
  const body = str(content.body) ?? str(notification.body) ?? str(data.message)
  const id = messageIdOf(value)
  if (!title || !SPOKEN_TITLES.includes(title) || !id) return null
  const text = `${title}. ${(body ?? '').replace(/\s*·\s*/g, ', ')}`.trim().replace(/[.,]?$/, '.')
  return { id: `msg:${id}`, text, source: 'notification title and text' }
}

/** A short outline of a notification's structure for the voice log ("{data{body, title}, messageId}"). */
export function describeShape(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return value.trim().startsWith('{') && depth < 5 ? `json${describeShape(safeParse(value), depth + 1)}` : 'text'
  if (typeof value !== 'object') return typeof value
  if (depth >= 5) return '{…}'
  const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
    v && typeof v === 'object' ? `${k}${describeShape(v, depth + 1)}` : typeof v === 'string' && v.trim().startsWith('{') ? `${k}:${describeShape(v, depth + 1)}` : k
  )
  return `{${parts.join(', ')}}`.slice(0, 400)
}
const safeParse = (text: string) => {
  try {
    return JSON.parse(text)
  } catch {
    return 'bad json'
  }
}

// ------------------------------------------------------------------------------------- voice choice

/** A voice the phone has, as expo-speech lists it (language like "en-IN"). */
export interface VoiceInfo {
  identifier: string
  language: string
  name?: string
}

/** One way to ask for a voice: expo-speech's `language` and `voice` options, and a name for people. */
export interface VoiceChoice {
  language?: string
  voice?: string
  label: string
}

const languageOf = (code: string) => code.replace('_', '-').toLowerCase()

/** On-device voices first: "network" voices need the internet, which a factory phone may not have. */
const offlineFirst = (a: VoiceInfo, b: VoiceInfo) => Number(/network/i.test(a.identifier)) - Number(/network/i.test(b.identifier))

/**
 * The voices to try, best first: an Indian English voice when the phone has one, otherwise another
 * English voice, then the speech engine's own English, then the phone's default voice. The language
 * is passed as "en" (expo-speech on Android reads "en-IN" as an unknown language and falls back to
 * the phone default); the exact voice is chosen by its identifier, as the phone lists it.
 */
export function chooseVoices(voices: VoiceInfo[]): VoiceChoice[] {
  const english = voices.filter((v) => /^en(-|$)/.test(languageOf(v.language)))
  const indian = english.filter((v) => languageOf(v.language) === 'en-in').sort(offlineFirst)[0]
  const other = english.filter((v) => languageOf(v.language) !== 'en-in').sort(offlineFirst)[0]
  const choices: VoiceChoice[] = []
  if (indian) choices.push({ language: 'en', voice: indian.identifier, label: 'English (India)' })
  else if (other) choices.push({ language: 'en', voice: other.identifier, label: `English (${other.language})` })
  choices.push({ language: 'en', label: 'English' })
  choices.push({ label: 'phone default voice' })
  return choices
}

// ------------------------------------------------------------------------------------- speaking

/** The speech engine as used here (expo-speech in the app, a fake in tests). */
export interface SpeechEngine {
  speak: (
    text: string,
    options: { language?: string; voice?: string; rate?: number; onStart: () => void; onDone: () => void; onStopped: () => void; onError: (e?: unknown) => void }
  ) => void
  stop: () => Promise<void>
  /** Whether it is speaking now (some engines do not report the start). */
  isSpeaking?: () => Promise<boolean>
}

export interface SpeechTiming {
  /** How long the engine may take to start speaking (it may first have to start up). */
  startMs: number
  /** How long one text may take once it started. */
  finishMs: (text: string) => number
  /** How long stopping may take before it is given up. */
  stopMs: number
}

export const DEFAULT_TIMING: SpeechTiming = {
  startMs: 10_000,
  finishMs: (text) => Math.min(60_000, 8_000 + text.length * 110),
  stopMs: 2_000
}

export type SpeakResult = { ok: true; voice: string } | { ok: false; reason: string }

/** Resolves with the promise's value, or with `fallback` after `ms` (a stuck engine never blocks). */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

type Attempt = 'done' | 'stopped' | 'error' | 'start-timeout' | 'finish-timeout'

/** One Speech.speak call, watched by a start and a finish timer; resolves exactly once. */
function speakOnce(engine: SpeechEngine, text: string, choice: VoiceChoice, timing: SpeechTiming, onStart?: () => void): Promise<{ result: Attempt; started: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    let started = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (result: Attempt) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ result, started })
    }
    const begin = () => {
      if (settled || started) return
      started = true
      clearTimeout(timer)
      timer = setTimeout(() => finish('finish-timeout'), timing.finishMs(text))
      try {
        onStart?.()
      } catch {
        // Only a report; speaking goes on.
      }
    }
    timer = setTimeout(async () => {
      // No start reported in time: if it is speaking anyway, give it the finish time; otherwise give up.
      const speaking = engine.isSpeaking ? await withTimeout(engine.isSpeaking(), 1_000, false) : false
      if (speaking) begin()
      else finish('start-timeout')
    }, timing.startMs)
    try {
      engine.speak(text, {
        language: choice.language,
        voice: choice.voice,
        rate: 0.9,
        onStart: begin,
        onDone: () => finish('done'),
        onStopped: () => finish('stopped'),
        onError: () => finish('error')
      })
    } catch {
      finish('error')
    }
  })
}

/**
 * Speaks a text with the first voice that works, never longer than the time limits allow. A voice
 * that fails before saying anything (not on the phone, engine error, engine not answering) is stopped
 * and the next choice is tried; once something was said, it is not repeated with another voice.
 */
export async function speakSafely(
  engine: SpeechEngine,
  text: string,
  choices: VoiceChoice[],
  timing: SpeechTiming = DEFAULT_TIMING,
  /** Called when the voice actually starts, with the voice used. */
  onStart?: (voice: string) => void
): Promise<SpeakResult> {
  let reason = 'no voice could be used'
  for (const choice of choices) {
    const { result, started } = await speakOnce(engine, text, choice, timing, () => onStart?.(choice.label))
    if (result === 'done') return { ok: true, voice: choice.label }
    // Clear what is stuck in the engine, so nothing old starts talking over the next one.
    await withTimeout(engine.stop(), timing.stopMs, undefined)
    if (started) {
      return { ok: false, reason: result === 'finish-timeout' ? 'the voice did not finish in time' : 'the voice stopped part-way' }
    }
    reason =
      result === 'start-timeout' ? 'the phone voice engine did not respond' : result === 'stopped' ? 'the voice was stopped' : 'the phone voice engine reported an error'
  }
  return { ok: false, reason }
}

// ------------------------------------------------------------------------------------- the queue

export interface VoiceQueueDeps {
  /** The worker's Voice Alerts switch. */
  enabled: () => Promise<boolean>
  /**
   * Records the alert as handled; false when it already was (kept on the phone for a day, so the app
   * and the background task, or a restart, never say one twice). Done before speaking.
   */
  claim: (id: string, via: string) => Promise<boolean>
  /**
   * Speaks and resolves when the voice has finished or failed (always within its time limits); calls
   * onStart when the voice actually starts. Test voice and real alerts use this same function.
   */
  speak: (text: string, onStart?: (voice: string) => void) => Promise<SpeakResult>
  /** Records how an alert went (spoken, or why not), after the attempt. */
  record: (id: string, via: string, result: SpeakResult) => Promise<void>
  /** Longest one queued item may take before the queue moves on regardless. */
  itemTimeoutMs?: number
  /** Notes each step (received, queued, started, spoken / why not) for the on-phone voice log. */
  trace?: (step: string, detail?: string) => void
}

/**
 * Speaks alerts in turn, never two at once: each waits for the one before it to finish. An alert is
 * spoken once, however many times it arrives (notification listener, background task, refreshes).
 * Nothing can hold the queue for longer than `itemTimeoutMs`.
 */
export function createVoiceQueue(deps: VoiceQueueDeps) {
  const trace = (step: string, detail?: string) => {
    try {
      deps.trace?.(step, detail)
    } catch {
      // The log never stops a voice.
    }
  }
  const seen = new Set<string>()
  const itemTimeoutMs = deps.itemTimeoutMs ?? 120_000
  let tail: Promise<unknown> = Promise.resolve()

  /** Runs `job` after everything queued before it; a failing or stuck job never blocks the next. */
  function enqueue<T>(job: () => Promise<T>, fallback: T): Promise<T> {
    const run = () => withTimeout(job(), itemTimeoutMs, fallback)
    const result = tail.then(run, run)
    tail = result.catch(() => undefined)
    return result
  }

  /** A real alert: spoken once. Resolves true when this call spoke it. */
  function announce(alert: VoiceAlert, via: string): Promise<boolean> {
    // Already queued in this app session (by any of its ids): the second copy is dropped at once.
    const ids = [alert.id, ...(alert.altIds ?? [])]
    if (ids.some((id) => seen.has(id))) {
      trace('skipped: already queued', `${alert.id} (${via})`)
      return Promise.resolve(false)
    }
    ids.forEach((id) => seen.add(id))
    trace('queued', `${alert.id} (${via})`)
    return enqueue(async () => {
      if (!(await deps.enabled())) {
        trace('skipped: Voice alerts is off', alert.id)
        return false
      }
      // Every id is recorded, so the other trigger (or a restart) finds it under whichever id it has.
      let fresh = true
      for (const id of ids) if (!(await deps.claim(id, via))) fresh = false
      if (!fresh) {
        trace('skipped: already spoken earlier', alert.id)
        return false
      }
      const result = await deps
        .speak(alert.text, (voice) => trace('speech started', voice))
        .catch((): SpeakResult => ({ ok: false, reason: 'the voice failed' }))
      trace(result.ok ? 'spoken' : 'not spoken', result.ok ? result.voice : result.reason)
      await deps.record(alert.id, via, result).catch(() => undefined)
      return result.ok
    }, false)
  }

  /**
   * Something spoken in the same queue but outside the alert rules (Test voice): no switch, no
   * "already spoken" memory, not recorded as an alert. It still waits its turn, so voices never overlap.
   */
  function exclusive(text: string): Promise<SpeakResult> {
    trace('test voice queued')
    return enqueue(async () => {
      const result = await deps.speak(text, (voice) => trace('test voice started', voice))
      trace(result.ok ? 'test voice spoken' : 'test voice not spoken', result.ok ? result.voice : result.reason)
      return result
    }, { ok: false, reason: 'the voice took too long' } as SpeakResult)
  }

  return { announce, exclusive }
}

/**
 * A notification arrived (open-app listener or background task): find its voice text and queue it.
 * Every step goes to the voice log; a notification without voice text is only logged (it is shown as
 * usual, nothing else happens).
 */
export function handleIncoming(
  data: unknown,
  via: string,
  announce: (alert: VoiceAlert, via: string) => Promise<boolean>,
  trace: (step: string, detail?: string) => void = () => undefined
): Promise<boolean> {
  try {
    trace('notification received', via)
    const messageId = messageIdOf(data)
    const found = findVoiceAlert(data)
    const alert: VoiceAlert | null = found
      ? { ...found, altIds: messageId ? [`msg:${messageId}`] : [], source: 'voice text' }
      : fallbackVoiceAlert(data)
    if (!alert) {
      trace('no voice text in notification', `shape: ${describeShape(data)}`)
      return Promise.resolve(false)
    }
    trace(found ? 'voice text found' : 'voice text made from the notification title and text', alert.id)
    return announce(alert, via).catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}
