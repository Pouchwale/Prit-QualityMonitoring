import React, { useEffect, useState } from 'react'
import { AppState, Platform, View } from 'react-native'
import { AssignedMachine, Profile } from '../types'
import { onNotificationTap, registerForPush, requestNotificationPermission, unregisterForPush } from '../services/notifications'
import { TabBar } from '../components/ui/TabBar'
import type { IconName } from '../components/ui/Icon'
import { HomeScreen } from '../screens/HomeScreen'
import { MachineScreen } from '../screens/MachineScreen'
import { HistoryScreen } from '../screens/HistoryScreen'
import { ProfileScreen } from '../screens/ProfileScreen'
import { CheckScreen } from '../screens/CheckScreen'
import { HistoryDetailScreen } from '../screens/HistoryDetailScreen'
import { JobScreen } from '../screens/JobScreen'

type Tab = 'today' | 'history' | 'profile'

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'today', label: 'Today', icon: 'today-outline' },
  { key: 'history', label: 'History', icon: 'time-outline' },
  { key: 'profile', label: 'Profile', icon: 'person-circle-outline' }
]

const isWeb = Platform.OS === 'web'

/**
 * The worker part of the mobile app: machines, checks with photo/video, exceptions, history and
 * alerts. The same code runs on Android and as the web app (served by the backend at /app).
 */
export const WorkerApp: React.FC<{ profile: Profile; onLogout: () => Promise<void> }> = ({ profile, onLogout }) => {
  const [tab, setTab] = useState<Tab>('today')
  const [machine, setMachine] = useState<AssignedMachine | null>(null)
  const [openCheck, setOpenCheck] = useState<{ id: string; startWith?: 'exception' } | null>(null)
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  const [openJobId, setOpenJobId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Register this device for alerts. Phones ask for permission here; browsers only allow asking
  // after a tap, so the web app asks from Profile → "Turn on alerts".
  useEffect(() => {
    if (isWeb) {
      registerForPush()
      return
    }
    // registerForPush also reports a refusal to the backend, so call it either way.
    requestNotificationPermission().then(() => registerForPush())
  }, [])

  // Try again whenever the app comes back to the front: the worker may have allowed
  // notifications in Settings meanwhile, or the server was unreachable last time.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') registerForPush()
    })
    return () => sub.remove()
  }, [])

  // Tapping "Quality check due" opens that check.
  useEffect(() => {
    return onNotificationTap((checkId) => {
      setTab('today')
      setOpenCheck({ id: checkId })
    })
  }, [])

  const handleLogout = async () => {
    await unregisterForPush()
    await onLogout()
  }

  const closeCheck = (submitted: boolean) => {
    setOpenCheck(null)
    if (submitted) setRefreshKey((k) => k + 1)
  }

  let screen: React.ReactNode
  if (openCheck) {
    screen = (
      <CheckScreen
        key={openCheck.id}
        checkId={openCheck.id}
        startWith={openCheck.startWith}
        onClose={closeCheck}
        onOpenCheck={(id) => {
          setRefreshKey((k) => k + 1)
          setOpenCheck({ id })
        }}
      />
    )
  } else if (openRecordId) {
    screen = <HistoryDetailScreen checkId={openRecordId} onClose={() => setOpenRecordId(null)} />
  } else if (openJobId) {
    screen = <JobScreen key={`${openJobId}-${refreshKey}`} jobId={openJobId} onBack={() => setOpenJobId(null)} onOpenCheck={(id) => setOpenCheck({ id })} />
  } else if (tab === 'today' && machine) {
    screen = (
      <MachineScreen
        machine={machine}
        meId={profile.id}
        refreshKey={refreshKey}
        onBack={() => setMachine(null)}
        onStart={(id, startWith) => setOpenCheck({ id, startWith })}
        onOpenJob={setOpenJobId}
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

  return <View className="flex-1 bg-canvas">{screen}</View>
}
