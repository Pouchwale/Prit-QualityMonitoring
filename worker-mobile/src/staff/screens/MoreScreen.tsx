import React from 'react'
import { Text } from 'react-native'
import type { ModuleKey } from '../types'
import { useStaff, type TabKey } from '../nav'
import { ROLE_LABEL } from '../format'
import { ActionList, ActionRow, Badge, List, ProfileCard, Row, Screen, Section, confirm, type IconName } from '../ui'

interface Entry {
  label: string
  description: string
  screen: string
  icon: IconName
  /** Shown when the account may view this module. */
  module?: ModuleKey
  /** Shown when the account may view any of these modules (for screens that read several). */
  anyModules?: ModuleKey[]
  /** Admin / Super Admin only. */
  adminOnly?: boolean
  /** Opens this bottom tab (when it is shown) instead of pushing a second copy. */
  tab?: TabKey
}

const GROUPS: { title: string; detail?: string; entries: Entry[] }[] = [
  {
    title: 'Monitoring',
    entries: [
      { label: 'Quality Checks', description: 'Scheduled checks, values and evidence', screen: 'checks', icon: 'clipboard-outline', module: 'checks', tab: 'checks' },
      { label: 'Exceptions', description: 'Checks workers could not perform', screen: 'exceptions', icon: 'alert-circle-outline', module: 'exceptions', tab: 'exceptions' },
      { label: 'Reports', description: 'Summaries, CSV and PDF', screen: 'reports', icon: 'bar-chart-outline', module: 'reports', tab: 'reports' },
      { label: 'Plant Calendar', description: 'Holidays and working days', screen: 'calendar', icon: 'calendar-outline', module: 'calendar' }
    ]
  },
  {
    title: 'People',
    entries: [
      { label: 'Workers & Users', description: 'Accounts, roles and app access', screen: 'users', icon: 'people-outline', module: 'workers' },
      { label: 'Machine Assignment', description: 'Machines each worker handles', screen: 'assignments', icon: 'git-network-outline', module: 'assignments' },
      { label: 'Manager Access', description: 'What each Manager may do', screen: 'managerAccess', icon: 'shield-checkmark-outline', adminOnly: true }
    ]
  },
  {
    title: 'Plant setup',
    detail: 'In setup order',
    entries: [
      {
        label: 'Monitoring Setup',
        description: 'Photo, video, intervals and N/A reasons',
        screen: 'monitoringSetup',
        icon: 'options-outline',
        anyModules: ['activities', 'schedules']
      },
      { label: 'Departments', description: 'Plant departments', screen: 'departments', icon: 'business-outline', module: 'departments' },
      { label: 'Shifts', description: 'Shift timings', screen: 'shifts', icon: 'time-outline', module: 'shifts' },
      { label: 'Parameters', description: 'Quality parameters and limits', screen: 'parameters', icon: 'speedometer-outline', module: 'parameters' },
      { label: 'Check Types', description: 'Parameters and evidence rules', screen: 'activities', icon: 'list-outline', module: 'activities' },
      { label: 'Machines', description: 'Machines and their check types', screen: 'machines', icon: 'construct-outline', module: 'machines' },
      { label: 'Schedules', description: 'How often each check runs', screen: 'schedules', icon: 'alarm-outline', module: 'schedules' }
    ]
  },
  {
    title: 'System',
    entries: [
      { label: 'Audit Logs', description: 'Who changed what and when', screen: 'auditLogs', icon: 'document-text-outline', module: 'audit_logs' },
      { label: 'Settings', description: 'Plant name and alerts', screen: 'settings', icon: 'settings-outline', module: 'settings' }
    ]
  }
]

/** Modules that only have a view level, so "View only" would say nothing. */
const VIEW_ONLY_MODULES: ModuleKey[] = ['dashboard', 'reports', 'audit_logs']

/** All modules: every module this account may open, grouped like the web panel's sidebar. */
export const MoreScreen: React.FC = () => {
  const { profile, can, isAdmin, push, switchTab, signOut } = useStaff()
  const visible = (e: Entry) =>
    e.adminOnly ? isAdmin : e.anyModules ? e.anyModules.some((m) => can(m)) : e.module ? can(e.module) : true
  const open = (e: Entry) => (e.tab && e.module && can(e.module) ? switchTab(e.tab) : push(e.screen))

  return (
    <Screen title="All modules">
      <ProfileCard name={profile.name} role={ROLE_LABEL[profile.role]} employeeId={profile.employeeId} onPress={() => push('account')} />

      {GROUPS.map((group) => {
        const entries = group.entries.filter(visible)
        if (entries.length === 0) return null
        return (
          <Section key={group.title} title={group.detail ? `${group.title} · ${group.detail.toLowerCase()}` : group.title} small>
            <List>
              {entries.map((e) => {
                const viewOnly = !isAdmin && !!e.module && !VIEW_ONLY_MODULES.includes(e.module) && can(e.module) && !can(e.module, 'manage')
                return (
                  <Row
                    key={e.screen}
                    icon={e.icon}
                    title={e.label}
                    subtitle={e.description}
                    accessibilityLabel={e.label}
                    right={viewOnly ? <Badge label="View only" /> : null}
                    onPress={() => open(e)}
                  />
                )
              })}
            </List>
          </Section>
        )
      })}

      <ActionList>
        <ActionRow icon="person-circle-outline" label="My Account" description="Profile, access and sign out" accessibilityLabel="My Account" onPress={() => push('account')} />
        <ActionRow
          icon="log-out-outline"
          label="Sign out"
          tone="danger"
          accessibilityLabel="Sign out"
          onPress={async () => {
            if (await confirm('Sign out?', 'You will need your employee ID and password to sign in again.', 'Sign out', true)) await signOut()
          }}
        />
      </ActionList>
      <Text className="-mt-3 px-4 text-[13px] leading-[18px] text-staff-muted">Only the modules your account may use are listed.</Text>
    </Screen>
  )
}
