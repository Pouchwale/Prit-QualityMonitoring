import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AssignedMachine, Profile } from '../types'
import { getMyMachines } from '../services/api'
import { showDialog } from '../utils/dialog'
import { alertHelp, notificationsAllowed, registerForPush, requestNotificationPermission, usesServerPush } from '../services/notifications'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { Button } from '../components/ui/Button'
import { Icon, ICON_COLOR } from '../components/ui/Icon'
import { EmptyState } from '../components/ui/LoadState'

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

export const ProfileScreen: React.FC<Props> = ({ profile, onLogout }) => {
  const insets = useSafeAreaInsets()
  const [machines, setMachines] = useState<AssignedMachine[] | null>(null)
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

          <ListGroup>
            <Row label="Employee ID" value={profile.employeeId} />
            <Row label="Department" value={profile.departmentName} />
            <Row
              label="Shift"
              value={profile.shiftName ? `${profile.shiftName} (${profile.shiftStartTime} – ${profile.shiftEndTime})` : null}
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
