import './global.css'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { AppState, Platform, Text, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Profile } from './src/types'
import { ApiError, SHIFT_ENDED, canChangeServer, getMe, logout, onSessionExpired, restoreSession } from './src/services/api'
import { endShiftLocally, registerServiceWorker, stopAlertsLocally } from './src/services/notifications'
import { formatTime } from './src/utils/datetime'
import { Icon } from './src/components/ui/Icon'
import { clearDownloads } from './src/services/files'
import { draftStorage } from './src/services/storage'
// Defines the background voice alert task; it must be loaded before anything else runs.
import './src/services/voiceTask'
import { Loading, ErrorState } from './src/components/ui/LoadState'
import { Button } from './src/components/ui/Button'
import { ServerSettingsSheet } from './src/components/ServerSettingsSheet'
import { DialogHost } from './src/components/ui/AppDialog'
import { LoginScreen } from './src/screens/LoginScreen'
import { WorkerApp } from './src/worker/WorkerApp'
import { StaffApp } from './src/staff/StaffApp'

const isWeb = Platform.OS === 'web'

/**
 * One app for every role. The account's role comes from the backend after sign-in:
 * Workers get the quality check app; Managers, Admins and the Super Admin get the monitoring and
 * administration app, limited to the modules their account may use (enforced by the backend).
 * The same code runs as the Android app and, exported for the web, as the web app at /app.
 */
export default function App() {
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [serverOpen, setServerOpen] = useState(false)
  /** Shown on the sign-in page after the server ended the sign-in at the end of the shift. */
  const [signInNotice, setSignInNotice] = useState<string | null>(null)
  /** The shift has ended but the server could not be reached yet to confirm it (offline). */
  const [awaitingShiftEnd, setAwaitingShiftEnd] = useState(false)
  const profileRef = useRef<Profile | null>(null)
  profileRef.current = profile

  const boot = useCallback(async () => {
    setBooting(true)
    setBootError(null)
    try {
      setProfile(await restoreSession())
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Please try again.')
    } finally {
      setBooting(false)
    }
  }, [])

  useEffect(() => {
    boot()
    // Web app: the service worker makes it installable and receives notifications.
    registerServiceWorker()
    // The server no longer accepts this sign-in: this device stops that user's alerts and voice,
    // removes their downloaded reports and shows the sign-in page. Unsent check drafts are kept for
    // signing in again.
    onSessionExpired((reason) => {
      if (reason === SHIFT_ENDED) {
        // The shift is over: no more check alerts, but the phone keeps the voice service for the
        // next shift's login reminder (the server only sends that to a signed-out phone).
        endShiftLocally()
        const endsAt = profileRef.current?.sessionEndsAt
        setSignInNotice(
          `Your shift ended${endsAt ? ` at ${formatTime(endsAt)}` : ''}. Sign in again at the start of your next shift. Readings you had not sent yet are saved on this phone.`
        )
      } else {
        stopAlertsLocally()
      }
      clearDownloads()
      setProfile(null)
    })
  }, [boot])

  // Workers with a shift: at the end of the shift the app asks the server, which ends the sign-in
  // (api.ts then shows the sign-in page). Only the server's answer signs the worker out: without a
  // connection the app keeps working, says so, and asks again every 30 seconds.
  const sessionEndsAt = profile?.sessionEndsAt ?? null
  const profileId = profile?.id ?? null
  useEffect(() => {
    setAwaitingShiftEnd(false)
    const endsAt = sessionEndsAt ? new Date(sessionEndsAt).getTime() : NaN
    if (!profileId || !Number.isFinite(endsAt)) return
    let cancelled = false
    let busy = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, Math.min(Math.max(ms, 1000), 2_147_000_000))
    }
    const check = async () => {
      if (cancelled || busy) return
      if (Date.now() < endsAt) return schedule(endsAt - Date.now())
      busy = true
      try {
        const me = await getMe()
        if (cancelled) return
        if ((me.sessionEndsAt ?? null) !== sessionEndsAt) {
          // The server has another end (the phone's clock differs, or the shift changed): follow it.
          setProfile((p) => (p && p.id === me.id ? { ...p, sessionEndsAt: me.sessionEndsAt ?? null } : p))
          return
        }
      } catch (err) {
        // Refused (401): api.ts has already ended the session.
        if (cancelled || (err instanceof ApiError && err.status === 401)) return
      } finally {
        busy = false
      }
      setAwaitingShiftEnd(true)
      schedule(30_000)
    }
    schedule(endsAt - Date.now())
    // Timers do not run while the phone sleeps: check again when the app comes back.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() >= endsAt) check()
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      sub.remove()
    }
  }, [profileId, sessionEndsAt])

  const signOut = async () => {
    await logout()
    // Nothing of this user is left for the next person on the device: downloaded reports and
    // unsent check drafts. (A session that only expired keeps the drafts for signing in again.)
    clearDownloads()
    await draftStorage.clear()
    setProfile(null)
  }

  let screen: React.ReactNode
  if (booting) {
    screen = <Loading />
  } else if (bootError) {
    screen = (
      <View className="flex-1 justify-center px-5">
        <ErrorState message={bootError} onRetry={boot} />
        {/* The server may have a new address: change it here, then the app starts again. */}
        {canChangeServer ? (
          <>
            <Button label="Server settings" icon="server-outline" variant="plain" onPress={() => setServerOpen(true)} className="mt-3" />
            <ServerSettingsSheet
              visible={serverOpen}
              problem={bootError}
              onClose={() => setServerOpen(false)}
              onSaved={() => {
                // Another server's address also removed the saved sign-in (api.ts setServerUrl),
                // so the app starts again from the sign-in page there.
                setServerOpen(false)
                setProfile(null)
                boot()
              }}
            />
          </>
        ) : null}
      </View>
    )
  } else if (!profile) {
    screen = (
      <LoginScreen
        notice={signInNotice}
        onSignedIn={(p) => {
          setSignInNotice(null)
          setProfile(p)
        }}
      />
    )
  } else if (profile.role === 'WORKER') {
    screen = <WorkerApp key={profile.id} profile={profile} onLogout={signOut} />
  } else {
    screen = <StaffApp key={profile.id} profile={profile} onProfileChange={setProfile} onLogout={signOut} />
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {/* On a PC browser the app keeps a phone-like column instead of stretching across the screen. */}
      <View className={`flex-1 ${isWeb ? 'bg-subtle' : 'bg-canvas'}`}>
        <View className={isWeb ? 'w-full max-w-[640px] flex-1 self-center border-x border-line bg-canvas' : 'flex-1 bg-canvas'}>
          {screen}
          {profile && awaitingShiftEnd ? <ShiftEndBanner /> : null}
        </View>
      </View>
      {/* Messages, questions and error popups from any screen. */}
      <DialogHost />
    </SafeAreaProvider>
  )
}

/**
 * The shift has ended but the server could not be reached to end the sign-in. The worker is not
 * signed out by the phone alone; their unsent readings stay saved either way.
 */
function ShiftEndBanner() {
  const insets = useSafeAreaInsets()
  return (
    <View pointerEvents="none" className="absolute left-3 right-3" style={{ top: insets.top + 8 }}>
      <View className="flex-row items-start rounded-xl bg-ink px-3.5 py-3" accessibilityRole="alert" accessibilityLiveRegion="polite">
        <Icon name="time-outline" size={18} color="#FFFFFF" />
        <Text className="ml-2 flex-1 text-[14px] leading-[19px] text-white">
          Your shift has ended. Signing you out when the server can be reached. Unsent readings are kept.
        </Text>
      </View>
    </View>
  )
}
