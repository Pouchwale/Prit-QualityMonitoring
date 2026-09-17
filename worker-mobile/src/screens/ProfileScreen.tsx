import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Profile } from '../types'
import { getMyMachines } from '../services/api'
import { showDialog } from '../utils/dialog'
import { alertHelp, notificationsAllowed, registerForPush, requestNotificationPermission, usesServerPush } from '../services/notifications'
import { LargeHeader } from '../components/ui/LargeHeader'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { Button } from '../components/ui/Button'

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
  <View className="min-h-[60px] flex-row items-center justify-between px-4 py-3">
    <Text className="text-[17px] text-ink-muted">{label}</Text>
    <Text className="ml-4 flex-1 text-right text-[17px] font-semibold text-ink" numberOfLines={2}>
      {value || '—'}
    </Text>
  </View>
)

export const ProfileScreen: React.FC<Props> = ({ profile, onLogout }) => {
  const insets = useSafeAreaInsets()
  const [machines, setMachines] = useState<{ id: string; name: string; code: string }[] | null>(null)
  const [alertsOn, setAlertsOn] = useState<boolean | null>(null)

  const [problem, setProblem] = useState<string | null>(null)

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
      showDialog('Alerts are off', alertHelp() ?? 'Open your phone Settings and allow notifications for this app.')
    }
  }

  const confirmLogout = () =>
    showDialog('Log out?', 'You will need your employee ID and password to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: onLogout }
    ])

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView className="flex-1" contentContainerClassName="px-5 pb-10">
        <LargeHeader title={profile.name} subtitle={profile.designation ?? ROLE_LABEL[profile.role]} />

        <View className="gap-8">
          <ListGroup>
            <Row label="Name" value={profile.name} />
            <Row label="Employee ID" value={profile.employeeId} />
            <Row label="Department" value={profile.departmentName} />
            <Row label="Role" value={profile.designation ?? ROLE_LABEL[profile.role]} />
            <Row
              label="Shift"
              value={profile.shiftName ? `${profile.shiftName} (${profile.shiftStartTime} – ${profile.shiftEndTime})` : null}
            />
          </ListGroup>

          <View>
            <SectionHeader title="My machines" />
            {machines === null ? (
              <View className="rounded-xl border border-line bg-surface px-4 py-5">
                <Text className="text-[16px] text-ink-muted">Loading…</Text>
              </View>
            ) : machines.length === 0 ? (
              <View className="rounded-xl border border-line bg-surface px-4 py-5">
                <Text className="text-[16px] font-medium text-ink">No machine assigned</Text>
                <Text className="mt-1 text-[15px] text-ink-muted">
                  Ask your supervisor to assign your machine. Until then you get no checks.
                </Text>
              </View>
            ) : (
              <>
                <ListGroup>
                  {machines.map((m) => (
                    <Row key={m.id} label={m.name} value={m.code} />
                  ))}
                </ListGroup>
                <Text className="mt-2 px-4 text-[14px] text-ink-muted">
                  You only get checks and alerts for these machines.
                </Text>
              </>
            )}
          </View>

          <View>
            <SectionHeader title="Alerts" />
            <View className="rounded-xl border border-line bg-surface px-4 py-4">
              <Text className="text-[16px] font-medium text-ink">
                {alertsOn === null ? 'Checking…' : alertsOn && !problem ? 'Alerts are on' : alertsOn ? 'Alerts are not working' : 'Alerts are off'}
              </Text>
              <Text className="mt-1 text-[15px] text-ink-muted">
                {alertsOn && !problem
                  ? usesServerPush()
                    ? 'You get an alert when a check is due.'
                    : 'Setting up alerts for this device…'
                  : alertsOn
                    ? problem
                    : 'Turn on alerts to know when a check is due.'}
              </Text>
              {alertsOn === false && problem ? <Text className="mt-2 text-[15px] leading-[21px] text-ink-secondary">{problem}</Text> : null}
              {alertsOn === false ? <Button label="Turn on alerts" variant="secondary" onPress={turnOnAlerts} className="mt-4" /> : null}
            </View>
          </View>

          <Button label="Log Out" variant="secondary" onPress={confirmLogout} />
        </View>
      </ScrollView>
    </View>
  )
}
