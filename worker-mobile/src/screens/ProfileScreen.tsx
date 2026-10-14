import React, { useCallback, useEffect, useState } from 'react'
import { useWorkerFeatures } from '../worker/features'
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AssignedMachine, Profile, VoiceLanguage } from '../types'
import { getMyMachines, setVoiceLanguage } from '../services/api'
import { showDialog } from '../utils/dialog'
import { alertHelp, notificationsAllowed, registerForPush, requestNotificationPermission, usesServerPush } from '../services/notifications'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { Button } from '../components/ui/Button'
import { Icon, ICON_COLOR } from '../components/ui/Icon'
import { EmptyState } from '../components/ui/LoadState'
import { formatClockRange, formatDateTime, formatTime } from '../utils/datetime'
import {
  lastVoiceAlert,
  testVoice,
  voiceAlertsSupported,
  voiceTraceEntries,
  type VoiceAlertResult,
  type VoiceTraceEntry
} from '../services/voiceAlerts'
import { MyPerformanceCard } from '../components/MyPerformanceCard'
import { MyWeekCard } from '../components/MyWeekCard'
import { MyOverallCard } from '../components/MyOverallCard'

interface Props {
  profile: Profile
  onLogout: () => void
}

const ROLE_LABEL: Record<Profile['role'], string> = {
  WORKER: 'Worker',
  MANAGER: 'Manager',
  ADMIN: 'Admin',
  SUPER_ADMIN: 'Super Admin'
}

const Row: React.FC<{ label: string; value: string | null }> = ({ label, value }) => (
  <View className="min-h-[52px] flex-row items-center justify-between px-4 py-3">
    <Text className="text-[17px] text-ink">{label}</Text>
    <Text className="ml-4 flex-1 text-right text-[17px] text-ink-muted" numberOfLines={2}>
      {value || '—'}
    </Text>
  </View>
)

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

/** Voice Notification Language choices (users.voice_notification_language). */
const VOICE_LANGUAGES: { key: VoiceLanguage; label: string }[] = [
  { key: 'en', label: 'English' },
  { key: 'hi', label: 'Hindi' },
  { key: 'gu', label: 'Gujarati' }
]

export const ProfileScreen: React.FC<Props> = ({ profile, onLogout }) => {
  const features = useWorkerFeatures()
  const insets = useSafeAreaInsets()
  const [machines, setMachines] = useState<AssignedMachine[] | null>(null)
  const [alertsOn, setAlertsOn] = useState<boolean | null>(null)

  const [problem, setProblem] = useState<string | null>(null)
  /** The language voice alerts are spoken in (saved on the server, used from the next alert on). */
  const [voiceLanguage, setLanguage] = useState<VoiceLanguage>(profile.voiceNotificationLanguage ?? 'en')
  const [savingLanguage, setSavingLanguage] = useState(false)
  const [lastVoice, setLastVoice] = useState<VoiceAlertResult | null>(null)
  const [testingVoice, setTestingVoice] = useState(false)
  /** What the last Test voice did: the voice it used, or why nothing was heard. */
  const [voiceTest, setVoiceTest] = useState<{ ok: boolean; text: string } | null>(null)
  /** The on-phone voice log (newest first): every step of every voice alert. */
  const [voiceLog, setVoiceLog] = useState<VoiceTraceEntry[]>([])
  const [showVoiceLog, setShowVoiceLog] = useState(false)
  const refreshVoice = useCallback(async () => {
    setLastVoice(await lastVoiceAlert())
    setVoiceLog(await voiceTraceEntries())
  }, [])

  useEffect(() => {
    if (!voiceAlertsSupported) return
    refreshVoice()
  }, [refreshVoice])

  const chooseLanguage = async (language: VoiceLanguage) => {
    if (language === voiceLanguage || savingLanguage) return
    const before = voiceLanguage
    setLanguage(language)
    setVoiceTest(null)
    setSavingLanguage(true)
    try {
      await setVoiceLanguage(language)
      // The signed-in profile is kept for the session: it shows the new choice when Profile opens again.
      profile.voiceNotificationLanguage = language
    } catch (err) {
      setLanguage(before)
      showDialog('Language not saved', err instanceof Error ? err.message : 'Please try again.', [], 'warning')
    } finally {
      setSavingLanguage(false)
    }
  }

  /** Says a sample on this phone, the way real alerts are spoken, to check the voice and the volume. */
  const runVoiceTest = async () => {
    setTestingVoice(true)
    setVoiceTest(null)
    const result = await testVoice(voiceLanguage)
    setTestingVoice(false)
    setVoiceTest(
      result.ok
        ? { ok: true, text: `Spoken with ${result.voice}. If you did not hear it, turn up the alarm volume.` }
        : { ok: false, text: `Not spoken: ${result.reason}. Check the phone's text-to-speech settings and the alarm volume.` }
    )
    await refreshVoice()
  }

  const refreshAlertState = useCallback(async () => {
    const allowed = await notificationsAllowed()
    if (allowed) await registerForPush()
    setAlertsOn(allowed)
    setProblem(alertHelp())
  }, [])

  useEffect(() => {
    getMyMachines()
      .then(setMachines)
      .catch(() => setMachines([]))
    refreshAlertState()
  }, [refreshAlertState])

  const turnOnAlerts = async () => {
    const granted = await requestNotificationPermission()
    await registerForPush()
    setAlertsOn(granted)
    setProblem(alertHelp())
    if (!granted) {
      showDialog('Alerts are off', alertHelp() ?? 'Open your phone Settings and allow notifications for this app.', [], 'warning')
    }
  }

  const confirmLogout = () =>
    showDialog('Log out?', 'You will need your employee ID and password to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: onLogout }
    ])

  const alertsWorking = !!alertsOn && !problem
  const alertTitle =
    alertsOn === null ? 'Checking…' : alertsWorking ? 'Alerts are on' : alertsOn ? 'Alerts are not working' : 'Alerts are off'
  const alertText = alertsWorking
    ? usesServerPush()
      ? 'You get an alert when a check is due.'
      : 'Setting up alerts for this device…'
    : alertsOn
      ? problem
      : 'Turn on alerts to know when a check is due.'

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView className="flex-1" contentContainerClassName="px-5 pb-12">
        <View className="pb-6 pt-5">
          <Text className="text-[32px] font-bold leading-[38px] tracking-[-0.6px] text-ink" accessibilityRole="header">
            Profile
          </Text>
        </View>

        <View className="gap-8">
          <View className="flex-row items-center rounded-2xl bg-surface p-4">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-accent-soft">
              <Text className="text-[20px] font-semibold text-accent">{initials(profile.name)}</Text>
            </View>
            <View className="ml-3.5 flex-1">
              <Text className="text-[20px] font-semibold text-ink" numberOfLines={1}>
                {profile.name}
              </Text>
              <Text className="mt-0.5 text-[15px] text-ink-muted" numberOfLines={1}>
                {profile.designation ?? ROLE_LABEL[profile.role]}
              </Text>
            </View>
          </View>

          {/* The worker's own scores: when the Super Admin allows it for workers. */}
          {features.performance ? (
            <>
              <MyPerformanceCard />

              <MyOverallCard />

              <MyWeekCard />
            </>
          ) : null}

          <ListGroup>
            <Row label="Employee ID" value={profile.employeeId} />
            <Row label="Department" value={profile.departmentName} />
            <Row
              label="Shift"
              value={profile.shiftName ? `${profile.shiftName} (${formatClockRange(profile.shiftStartTime, profile.shiftEndTime)})` : null}
            />
          </ListGroup>

          <View>
            <SectionHeader title="My machines" />
            {machines === null ? (
              <View className="items-center rounded-2xl bg-surface py-6">
                <ActivityIndicator color={ICON_COLOR.muted} />
              </View>
            ) : machines.length === 0 ? (
              <EmptyState
                icon="construct-outline"
                title="No machine assigned"
                message="Ask your supervisor to assign your machine. Until then you get no checks."
              />
            ) : (
              <>
                <ListGroup>
                  {machines.map((m) => (
                    <Row key={m.id} label={m.name} value={m.code} />
                  ))}
                </ListGroup>
                <Text className="mt-2 px-4 text-[13px] leading-[18px] text-ink-muted">
                  You only get checks and alerts for these machines.
                </Text>
              </>
            )}
          </View>

          <View>
            <SectionHeader title="Alerts" />
            <View className="rounded-2xl bg-surface p-4">
              <View className="flex-row items-center">
                <View
                  className={`h-9 w-9 items-center justify-center rounded-full ${alertsWorking ? 'bg-success-bg' : 'bg-subtle'}`}
                >
                  <Icon
                    name={alertsWorking ? 'notifications' : 'notifications-off-outline'}
                    size={18}
                    color={alertsWorking ? 'success' : 'muted'}
                  />
                </View>
                <Text className="ml-3 flex-1 text-[17px] font-semibold text-ink">{alertTitle}</Text>
              </View>
              <Text className="mt-2 text-[15px] leading-[20px] text-ink-muted">{alertText}</Text>
              {alertsOn === false && problem ? <Text className="mt-2 text-[15px] leading-[21px] text-ink-secondary">{problem}</Text> : null}
              {alertsOn === false ? (
                <Button label="Turn on alerts" icon="notifications-outline" onPress={turnOnAlerts} className="mt-4" />
              ) : null}
              {voiceAlertsSupported ? (
                <View className="mt-4 border-t border-line pt-4">
                  <View className="flex-row items-center">
                    <View className="h-9 w-9 items-center justify-center rounded-full bg-success-bg">
                      <Icon name="volume-high" size={18} color="success" />
                    </View>
                    <Text className="ml-3 flex-1 text-[17px] font-semibold text-ink">Voice Notification Language</Text>
                    {savingLanguage ? <ActivityIndicator size="small" color={ICON_COLOR.muted} /> : null}
                  </View>
                  <View className="mt-3 h-11 flex-row rounded-xl bg-line p-[3px]" accessibilityRole="radiogroup" accessibilityLabel="Voice Notification Language">
                    {VOICE_LANGUAGES.map((l) => {
                      const selected = voiceLanguage === l.key
                      return (
                        <Pressable
                          key={l.key}
                          onPress={() => chooseLanguage(l.key)}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          accessibilityLabel={l.label}
                          className={`flex-1 items-center justify-center rounded-[9px] ${selected ? 'bg-surface' : 'active:opacity-60'}`}
                        >
                          <Text className={`text-[15px] ${selected ? 'font-semibold text-ink' : 'font-medium text-ink-secondary'}`}>{l.label}</Text>
                        </Pressable>
                      )
                    })}
                  </View>
                  <Text className="mt-2 text-[15px] leading-[20px] text-ink-muted">
                    Each due check is also spoken aloud in this language. Notifications stay in English. Keep the alarm volume up.
                  </Text>
                  <Button label="Test voice" icon="volume-high-outline" variant="secondary" size="compact" loading={testingVoice} onPress={runVoiceTest} className="mt-3" />
                  {voiceTest ? (
                    <Text className={`mt-2 text-[14px] leading-[19px] ${voiceTest.ok ? 'text-success' : 'text-missed'}`}>{voiceTest.text}</Text>
                  ) : null}
                  {lastVoice ? (
                    <Text className="mt-2 text-[14px] leading-[19px] text-ink-faint">
                      Last voice alert {formatDateTime(new Date(lastVoice.at))} · {lastVoice.via} ·{' '}
                      {lastVoice.ok ? `spoken (${lastVoice.detail})` : `not spoken: ${lastVoice.detail}`}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={async () => {
                      if (!showVoiceLog) await refreshVoice()
                      setShowVoiceLog(!showVoiceLog)
                    }}
                    accessibilityRole="button"
                    className="mt-2 h-10 justify-center self-start active:opacity-50"
                  >
                    <Text className="text-[15px] font-semibold text-accent">{showVoiceLog ? 'Hide voice log' : 'Show voice log'}</Text>
                  </Pressable>
                  {showVoiceLog ? (
                    <View className="rounded-xl bg-subtle px-3 py-2">
                      {voiceLog.length === 0 ? (
                        <Text className="text-[13px] text-ink-muted">Nothing yet. Each voice alert's steps appear here.</Text>
                      ) : (
                        voiceLog.slice(0, 20).map((e, i) => (
                          <Text key={`${e.at}-${i}`} className="py-0.5 text-[13px] leading-[17px] text-ink-secondary">
                            {formatTime(new Date(e.at))} · {e.step}
                            {e.detail ? ` · ${e.detail}` : ''}
                            {e.app ? ` · ${e.app}` : ''}
                          </Text>
                        ))
                      )}
                      <Pressable onPress={refreshVoice} accessibilityRole="button" className="mt-1 h-9 justify-center self-start active:opacity-50">
                        <Text className="text-[14px] font-semibold text-accent">Refresh</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>

          <ListGroup>
            <Pressable
              onPress={confirmLogout}
              accessibilityRole="button"
              accessibilityLabel="Log Out"
              className="h-[52px] items-center justify-center active:bg-subtle"
            >
              <Text className="text-[17px] font-medium text-missed">Log Out</Text>
            </Pressable>
          </ListGroup>
        </View>
      </ScrollView>
    </View>
  )
}
