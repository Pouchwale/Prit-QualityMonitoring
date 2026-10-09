import type { SpeakResult, VoiceAlert } from './voiceQueue'

/**
 * The web app (/app) has no voice alerts: a browser can only speak while the page is open and in
 * front, and its notifications come from a service worker, which cannot speak.
 */
export const voiceAlertsSupported = false

export interface VoiceAlertResult {
  at: number
  via: string
  ok: boolean
  detail: string
}

export const voiceAlertsEnabled = async () => false
export const setVoiceAlertsEnabled = async (_on: boolean) => undefined
export const lastVoiceAlert = async (): Promise<VoiceAlertResult | null> => null
export const announceVoiceAlert = async (_alert: VoiceAlert, _via: string) => false
export const testVoice = async (_language?: string): Promise<SpeakResult> => ({ ok: false, reason: 'voice alerts are only in the phone app' })

export interface VoiceTraceEntry {
  at: number
  step: string
  detail?: string
  app: string
}
export const voiceTrace = (_step: string, _detail?: string) => undefined
export const voiceTraceEntries = async (): Promise<VoiceTraceEntry[]> => []
export const handleNotificationData = async (_data: unknown, _via: string) => false
