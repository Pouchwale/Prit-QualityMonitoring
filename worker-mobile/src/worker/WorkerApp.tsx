import React, { useEffect, useMemo, useState } from 'react'
import { AppState, Platform, View } from 'react-native'
import { AssignedMachine, Profile } from '../types'
import { getPushToken, onLeaveNotificationTap, onNotificationTap, registerForPush, requestNotificationPermission, unregisterForPush } from '../services/notifications'
import { reportPresence } from '../services/api'
import { TabBar } from '../components/ui/TabBar'
import type { IconName } from '../components/ui/Icon'
import { HomeScreen } from '../screens/HomeScreen'
import { MachineScreen } from '../screens/MachineScreen'
import { HistoryScreen } from '../screens/HistoryScreen'
import { ProfileScreen } from '../screens/ProfileScreen'
import { LeaveScreen } from '../screens/LeaveScreen'
import { CheckScreen } from '../screens/CheckScreen'
import { HistoryDetailScreen } from '../screens/HistoryDetailScreen'
import { JobScreen } from '../screens/JobScreen'
import { dismissKeyboard } from '../utils/keyboard'
import { WorkerFeaturesContext, featuresOf } from './features'

/** How often the open app tells the server it is on company Wi-Fi (Company Wi-Fi rule). */
const PRESENCE_EVERY_MS = 2 * 60_000

type Tab = 'today' | 'history' | 'leave' | 'profile'

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'today', label: 'Today', icon: 'today-outline' },
  { key: 'history', label: 'History', icon: 'time-outline' },
  { key: 'leave', label: 'Leave', icon: 'calendar-outline' },
  { key: 'profile', label: 'Profile', icon: 'person-circle-outline' }
]

const isWeb = Platform.OS === 'web'

/**
 * The worker part of the mobile app: machines, checks with photo/video, exceptions, history and
 * alerts. The same code runs on Android and as the web app (served by the backend at /app).
 */
export const WorkerApp: React.FC<{ profile: Profile; onLogout: () => Promise<void> }> = ({ profile, onLogout }) => {
  // The app features the Super Admin allows for workers (worker/features.tsx).
  const features = useMemo(() => featuresOf(profile), [profile])
  const tabs = useMemo(() => TABS.filter((t) => (t.key !== 'history' || features.history) && (t.key !== 'leave' || features.leave)), [features])
  const [tab, setTab] = useState<Tab>('today')
  const [machine, setMachine] = useState<AssignedMachine | null>(null)
  const [openCheck, setOpenCheck] = useState<{ id: string; startWith?: 'exception' } | null>(null)
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  const [openJobId, setOpenJobId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [leaveForm, setLeaveForm] = useState(false)

  // Opening another screen closes the keyboard: it must never be left over the new one.
  useEffect(() => {
    dismissKeyboard()
  }, [tab, machine?.id, openCheck?.id, openRecordId, openJobId])

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

  // Company Wi-Fi rule: while the app is open, tell the plant server every 2 minutes (and on coming
  // back to the front) that this device can reach it. The server is only reachable on company Wi-Fi,
  // so a report that gets through is the proof; one that fails changes nothing here.
  useEffect(() => {
    const report = () => {
      if (AppState.currentState === 'active') reportPresence(getPushToken()).catch(() => undefined)
    }
    report()
    const timer = setInterval(report, PRESENCE_EVERY_MS)
    const sub = AppState.addEventListener('change', (state) => state === 'active' && report())
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [])

  // Tapping "Quality check due" opens that check.
  useEffect(() => {
    return onNotificationTap((checkId) => {
      setTab('today')
      setOpenCheck({ id: checkId })
    })
  }, [])

  // Tapping "Leave approved / rejected" opens the Leave tab.
  useEffect(() => {
    if (!features.leave) return
    return onLeaveNotificationTap(() => {
      setOpenCheck(null)
      setOpenRecordId(null)
      setOpenJobId(null)
      setMachine(null)
      setTab('leave')
      setRefreshKey((k) => k + 1)
    })
  }, [features.leave])

  const handleLogout = async () => {
    // The phone still gets this worker's shift-start login reminder (only that, until they sign in).
    await unregisterForPush({ keepShiftReminders: true })
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
          {tab === 'today' && (
            <HomeScreen
              profile={profile}
              refreshKey={refreshKey}
              onOpenMachine={setMachine}
              onStartCheck={(id, startWith) => setOpenCheck({ id, startWith })}
            />
          )}
          {tab === 'history' && features.history && <HistoryScreen refreshKey={refreshKey} onOpenRecord={setOpenRecordId} />}
          {tab === 'leave' && features.leave && <LeaveScreen refreshKey={refreshKey} onFormChange={setLeaveForm} />}
          {tab === 'profile' && <ProfileScreen profile={profile} onLogout={handleLogout} />}
        </View>
        {tab === 'leave' && leaveForm ? null : (
        <TabBar
          tabs={tabs}
          active={tab}
          onChange={(next) => {
            setTab(next)
            if (next !== 'today') setMachine(null)
          }}
        />
        )}
      </>
    )
  }

  return (
    <WorkerFeaturesContext.Provider value={features}>
      <View className="flex-1 bg-canvas">{screen}</View>
    </WorkerFeaturesContext.Provider>
  )
}
