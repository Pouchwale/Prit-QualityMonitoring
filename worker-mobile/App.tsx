import './global.css'
import React, { useCallback, useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { Platform, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Profile } from './src/types'
import { canChangeServer, logout, onSessionExpired, restoreSession } from './src/services/api'
import { registerServiceWorker } from './src/services/notifications'
import { Loading, ErrorState } from './src/components/ui/LoadState'
import { Button } from './src/components/ui/Button'
import { ServerSettingsSheet } from './src/components/ServerSettingsSheet'
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
    onSessionExpired(() => setProfile(null))
  }, [boot])

  const signOut = async () => {
    await logout()
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
                setServerOpen(false)
                boot()
              }}
            />
          </>
        ) : null}
      </View>
    )
  } else if (!profile) {
    screen = <LoginScreen onSignedIn={setProfile} />
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
        <View className={isWeb ? 'w-full max-w-[640px] flex-1 self-center border-x border-line bg-canvas' : 'flex-1 bg-canvas'}>{screen}</View>
      </View>
    </SafeAreaProvider>
  )
}
