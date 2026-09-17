import './global.css'
import React, { useCallback, useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { AppState, Platform, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Profile } from './src/types'
import { logout, onSessionExpired, restoreSession } from './src/services/api'
import {
  onNotificationTap,
  registerForPush,
  registerServiceWorker,
  requestNotificationPermission,
  unregisterForPush
} from './src/services/notifications'
import { TabBar } from './src/components/ui/TabBar'
import { Loading, ErrorState } from './src/components/ui/LoadState'
import { LoginScreen } from './src/screens/LoginScreen'
import { HomeScreen, type AssignedMachine } from './src/screens/HomeScreen'
import { MachineScreen } from './src/screens/MachineScreen'
import { HistoryScreen } from './src/screens/HistoryScreen'
import { ProfileScreen } from './src/screens/ProfileScreen'
import { CheckScreen } from './src/screens/CheckScreen'
import { HistoryDetailScreen } from './src/screens/HistoryDetailScreen'

type Tab = 'today' | 'history' | 'profile'

const TABS: { key: Tab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'history', label: 'History' },
  { key: 'profile', label: 'Profile' }
]

const isWeb = Platform.OS === 'web'

/**
 * The worker app. The same code runs as the Android app and, exported for the web, as the
 * web app / PWA for iPhones and PCs (served by the backend at /app).
 */
export default function App() {
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [tab, setTab] = useState<Tab>('today')
  const [machine, setMachine] = useState<AssignedMachine | null>(null)
  const [openCheck, setOpenCheck] = useState<{ id: string; startWith?: 'image' | 'exception' } | null>(null)
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

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
    onSessionExpired(() => {
      setProfile(null)
      setOpenCheck(null)
    })
  }, [boot])

  // Register this device for alerts once signed in. Phones ask for permission here; browsers
  // only allow asking after a tap, so the web app asks from Profile → "Turn on alerts".
  useEffect(() => {
    if (!profile) return
    if (isWeb) {
      registerForPush()
      return
    }
    // registerForPush also reports a refusal to the backend, so call it either way.
    requestNotificationPermission().then(() => registerForPush())
  }, [profile])

  // Try again whenever the app comes back to the front: the worker may have allowed
  // notifications in Settings meanwhile, or the server was unreachable last time.
  useEffect(() => {
    if (!profile) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') registerForPush()
    })
    return () => sub.remove()
  }, [profile])

  // Tapping "Quality check due" opens that check.
  useEffect(() => {
    return onNotificationTap((checkId) => {
      setTab('today')
      setOpenCheck({ id: checkId })
    })
  }, [])

  const handleLogout = async () => {
    await unregisterForPush()
    await logout()
    setProfile(null)
    setMachine(null)
    setOpenCheck(null)
    setOpenRecordId(null)
    setTab('today')
  }

  const closeCheck = (submitted: boolean) => {
    setOpenCheck(null)
    if (submitted) setRefreshKey((k) => k + 1)
  }

  let screen: React.ReactNode
  if (booting) {
    screen = <Loading />
  } else if (bootError) {
    screen = (
      <View className="flex-1 justify-center px-5">
        <ErrorState message={bootError} onRetry={boot} />
      </View>
    )
  } else if (!profile) {
    screen = (
      <LoginScreen
        onSignedIn={(p) => {
          setProfile(p)
          setTab('today')
        }}
      />
    )
  } else if (openCheck) {
    screen = <CheckScreen key={openCheck.id} checkId={openCheck.id} startWith={openCheck.startWith} onClose={closeCheck} />
  } else if (openRecordId) {
    screen = <HistoryDetailScreen checkId={openRecordId} onClose={() => setOpenRecordId(null)} />
  } else if (tab === 'today' && machine) {
    screen = (
      <MachineScreen
        machine={machine}
        refreshKey={refreshKey}
        onBack={() => setMachine(null)}
        onStart={(id, startWith) => setOpenCheck({ id, startWith })}
      />
    )
  } else {
    screen = (
      <>
        <View className="flex-1">
          {tab === 'today' && <HomeScreen profile={profile} refreshKey={refreshKey} onOpenMachine={setMachine} />}
          {tab === 'history' && <HistoryScreen refreshKey={refreshKey} onOpenRecord={setOpenRecordId} />}
          {tab === 'profile' && <ProfileScreen profile={profile} onLogout={handleLogout} />}
        </View>
        <TabBar
          tabs={TABS}
          active={tab}
          onChange={(next) => {
            setTab(next)
            if (next !== 'today') setMachine(null)
          }}
        />
      </>
    )
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
