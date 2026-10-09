import { requireOptionalNativeModule } from 'expo'

/**
 * The app's native voice alert service (modules/voice-alerts, Android, app 1.2.0+). It speaks due-check
 * alerts as they arrive, also with the app closed and the phone locked. Null where it is not built in
 * (app 1.1.0, Expo Go, the web app): the JavaScript voice (voiceAlerts.ts) is used there instead.
 */
export interface NativeVoiceAlerts {
  /** Where to send the voice log, this phone's Firebase token, and the Voice alerts switch. */
  configure(apiUrl: string | null, deviceToken: string | null, enabled: boolean): void
  setEnabled(enabled: boolean): void
  /** The voice log as JSON: [{ at, step, detail, state }], oldest first. */
  getLog(): string
  /** The last real alert as JSON { at, via, ok, detail }, or null. */
  getLastAlert(): string | null
  /** Says a sample the way alerts are spoken, in a language (English text as fallback); JSON { ok, detail }. */
  testVoice(text: string, language: string, fallbackText: string | null): Promise<string>
}

export const nativeVoice = requireOptionalNativeModule<NativeVoiceAlerts>('VoiceAlerts')
