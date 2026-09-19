import React, { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import type { Machine, Schedule, User } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import {
  Badge,
  Card,
  Chips,
  DataState,
  FormError,
  Icon,
  KV,
  List,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  SmallButton,
  confirm,
  useToast
} from '../ui'
import { ICON_COLOR } from '../Icon'
import { ActionGroup, ActionItem, Initials, PersonRow, SummaryHeader, facts } from './adminParts'
import { formatDateTime } from '../../utils/datetime'

interface AlertStatusReport {
  status: string
  platform: string | null
  detail: string | null
  at: string
}

interface TestResult {
  kind: 'success' | 'warning' | 'error'
  title: string
  message: string
}

/**
 * Why a worker has no registered device, from what their device last reported when it tried to
 * turn on alerts, with the step that fixes it (same wording as the web panel).
 */
function noDeviceReason(name: string, report: AlertStatusReport | null | undefined) {
  if (!report) {
    return `${name} has not opened an app version that can register for alerts. Ask them to sign in again to the Android app or the worker web app.`
  }
  const device = report.platform ? ` (${report.platform}, ${formatDateTime(report.at)})` : ''
  switch (report.status) {
    case 'no-project-id':
      return `${name}'s app${device} is not linked to an Expo project, so it cannot get a notification token. On the server PC run "npx eas-cli login" and "npx eas-cli init" in worker-mobile (see PUSH_SETUP.md), restart Expo, and reopen the app.`
    case 'expo-go-unsupported':
      return `${name} uses Expo Go on Android${device}, which cannot receive notifications. Install the Quality Worker APK.`
    case 'permission-denied':
      return `Notifications are not allowed on ${name}'s device${device}. Allow them in the phone or browser settings, then open Profile → Turn on alerts.`
    case 'insecure-context':
      return `${name} uses the worker web app over plain HTTP${device}. Browser notifications need the HTTPS address of the web app (see README → Worker web app).`
    case 'ios-needs-home-screen':
      return `${name} uses the web app in Safari on iPhone${device}. Add it to the Home Screen, open it from there and turn on alerts in Profile.`
    case 'unsupported-browser':
      return `${name}'s browser${device} cannot receive notifications. Use Chrome, Edge or Safari.`
    case 'registered':
      return `${name}'s device${device} was registered but has since been removed (signed out or uninstalled). Ask them to sign in again.`
    default:
      return `${name}'s device${device} could not register for alerts: ${report.detail ?? 'unknown error'}.`
  }
}

/** Workers, machines and schedules, as the web Machine Assignment page loads them. */
function useAssignmentData() {
  const usersApi = useQuery<User[]>('/api/users', { role: 'WORKER' })
  const machinesApi = useQuery<Machine[]>('/api/machines')
  const schedulesApi = useQuery<Schedule[]>('/api/schedules')
  const workers = useMemo(() => usersApi.data ?? [], [usersApi.data])
  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const schedules = useMemo(() => schedulesApi.data ?? [], [schedulesApi.data])
  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])
  const activeMachines = useMemo(() => machines.filter((m) => m.isActive), [machines])
  const reloadAll = () => {
    usersApi.reload()
    machinesApi.reload()
    schedulesApi.reload()
  }
  return {
    usersApi,
    machinesApi,
    schedulesApi,
    workers,
    machines,
    schedules,
    machineById,
    activeMachines,
    reloadAll,
    loading: usersApi.loading || machinesApi.loading || schedulesApi.loading,
    error: usersApi.error || machinesApi.error || schedulesApi.error,
    hasData: !!usersApi.data && !!machinesApi.data && !!schedulesApi.data
  }
}

const PREVIEW_LINES = 3

/** The first few lines of a warning, with a link to show the rest. */
const WarningLines: React.FC<{ lines: { key: string; node: React.ReactNode }[] }> = ({ lines }) => {
  const [open, setOpen] = useState(false)
  const shown = open ? lines : lines.slice(0, PREVIEW_LINES)
  const hidden = lines.length - PREVIEW_LINES
  return (
    <>
      {shown.map((l) => (
        <Text key={l.key} className="mt-1 text-[14px] leading-[19px] text-staff-ink2">
          {l.node}
        </Text>
      ))}
      {hidden > 0 ? (
        <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8 }} className="min-h-[44px] justify-center self-start active:opacity-60">
          <Text className="text-[14px] font-semibold text-staff-accent">{open ? 'Show less' : `Show ${hidden} more`}</Text>
        </Pressable>
      ) : null}
    </>
  )
}

type WorkerFilter = '' | 'unassigned'

/** Machine Assignment: which machines each worker sees, submits and is notified about, with coverage gaps. */
export const AssignmentsScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { push } = useStaff()
  const d = useAssignmentData()
  const { workers, schedules, machineById, activeMachines } = d
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<WorkerFilter>('')
  const onlyUnassigned = filter === 'unassigned'
  const [showHelp, setShowHelp] = useState(false)

  const schedulesByWorker = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of schedules) {
      if (!s.workerId) continue
      counts.set(s.workerId, (counts.get(s.workerId) ?? 0) + 1)
    }
    return counts
  }, [schedules])

  const unassignedWorkers = useMemo(() => workers.filter((w) => w.isActive && w.machineIds.length === 0), [workers])

  const workersByMachine = useMemo(() => {
    const map = new Map<string, User[]>()
    for (const m of activeMachines) map.set(m.id, [])
    for (const w of workers) {
      if (!w.isActive) continue
      for (const id of w.machineIds) map.get(id)?.push(w)
    }
    return map
  }, [activeMachines, workers])

  /** Schedules whose named worker lost access to that schedule's machine. */
  const broken = useMemo(() => {
    const byId = new Map(workers.map((w) => [w.id, w]))
    const rows: { schedule: Schedule; workerName: string }[] = []
    for (const s of schedules) {
      if (!s.workerId) continue
      const worker = byId.get(s.workerId)
      if (!worker || worker.machineIds.includes(s.machineId)) continue
      rows.push({ schedule: s, workerName: worker.name })
    }
    return rows
  }, [schedules, workers])

  /** Active schedules whose machine has no worker on that shift: one line per machine and shift. */
  const gaps = useMemo(() => {
    const lines = schedules.filter((s) => s.isActive && s.checkWorkers.length === 0).map((s) => ({ machineName: s.machineName, shiftName: s.shiftName }))
    return [...new Map(lines.map((g) => [`${g.machineName}|${g.shiftName}`, g])).values()]
  }, [schedules])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return workers.filter((w) => {
      if (onlyUnassigned && w.machineIds.length > 0) return false
      if (!q) return true
      const machineNames = w.machineIds.map((id) => machineById.get(id)?.name ?? '').join(' ')
      return [w.name, w.employeeId, w.designation, w.shiftName, w.departmentName, machineNames].some((v) => v?.toLowerCase().includes(q))
    })
  }, [workers, search, onlyUnassigned, machineById])

  const uncoveredMachines = activeMachines.filter((m) => (workersByMachine.get(m.id) ?? []).length === 0)
  const filterOptions = [
    { value: '' as WorkerFilter, label: 'All workers', count: workers.length },
    { value: 'unassigned' as WorkerFilter, label: 'Unassigned', count: workers.filter((w) => w.machineIds.length === 0).length }
  ]

  return (
    <Screen title="Machine Assignment" onRefresh={d.reloadAll} refreshing={d.loading && d.hasData}>
      <Notice tone="accent" title="A worker only sees checks for their machines">
        {showHelp ? (
          <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-ink2">
            The machine assignment decides everything a worker sees: a worker only sees, submits and is notified about quality checks for the machines assigned to them.
            If a worker is not assigned to a machine, checks for that machine never reach their phone, even if a schedule names them.
          </Text>
        ) : null}
        <Pressable onPress={() => setShowHelp((v) => !v)} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8 }} className="min-h-[44px] justify-center self-start active:opacity-60">
          <Text className="text-[14px] font-semibold text-staff-accent">{showHelp ? 'Show less' : 'How it works'}</Text>
        </Pressable>
      </Notice>

      {gaps.length > 0 ? (
        <Notice tone="missed" title={gaps.length === 1 ? 'Shift with no worker: its checks are not scheduled' : `${gaps.length} shifts with no worker: their checks are not scheduled`}>
          <WarningLines
            lines={gaps.map((g) => ({
              key: `${g.machineName}|${g.shiftName}`,
              node: (
                <>
                  <Text className="font-semibold text-staff-ink">{g.machineName}</Text> · {g.shiftName} — assign a worker on {g.shiftName} to {g.machineName} in Machine Assignment.
                </>
              )
            }))}
          />
        </Notice>
      ) : null}

      {unassignedWorkers.length > 0 ? (
        <Notice tone="exception" title={`${unassignedWorkers.length} active worker${unassignedWorkers.length === 1 ? ' has' : 's have'} no machine`}>
          <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-ink2">
            They receive nothing on the mobile app. Assign at least one machine to:{' '}
            <Text className="font-semibold text-staff-ink">{unassignedWorkers.map((w) => w.name).join(', ')}</Text>
          </Text>
        </Notice>
      ) : null}

      {broken.length > 0 ? (
        <Notice
          tone="missed"
          title={`${broken.length} schedule${broken.length === 1 ? '' : 's'} point at a worker who lost the machine`}
          message="This worker is not assigned to the machine, so they will not receive these checks. Either assign the machine to the worker below, or change the schedule."
        >
          <WarningLines
            lines={broken.map(({ schedule, workerName }) => ({
              key: schedule.id,
              node: (
                <>
                  <Text className="font-semibold text-staff-ink">{schedule.machineName}</Text> · {schedule.activityName} · {schedule.shiftName} —{' '}
                  <Text className="font-medium text-missed">{workerName}</Text>
                  {schedule.workerEmployeeId ? ` ${schedule.workerEmployeeId}` : ''}
                </>
              )
            }))}
          />
        </Notice>
      ) : null}

      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Search worker, employee ID, machine…" />
        <Chips options={filterOptions} value={filter} onChange={setFilter} />
      </View>

      <Section title="Workers">
        <DataState
          loading={d.loading}
          error={d.error}
          onRetry={d.reloadAll}
          hasData={d.hasData}
          empty={d.hasData && filtered.length === 0}
          emptyText={workers.length === 0 ? 'No workers yet' : 'No workers match the filters'}
          emptyIcon={workers.length === 0 ? 'people-outline' : 'search-outline'}
        >
          <List>
            {filtered.map((w) => {
              const assigned = w.machineIds.map((id) => machineById.get(id)).filter((m): m is Machine => !!m)
              const scheduleCount = schedulesByWorker.get(w.id) ?? 0
              return (
                <PersonRow
                  key={w.id}
                  name={w.name}
                  muted={!w.isActive}
                  subtitle={facts(
                    assigned.length ? assigned.map((m) => (m.isActive ? m.name : `${m.name} (disabled)`)).join(', ') : 'Not assigned — receives nothing',
                    w.shiftName,
                    scheduleCount > 0 ? `${scheduleCount} schedule${scheduleCount === 1 ? '' : 's'}` : null
                  )}
                  right={
                    !w.isActive ? (
                      <Badge label="Disabled" tone="missed" />
                    ) : assigned.length === 0 ? (
                      <Badge label="No machine" tone="exception" />
                    ) : !w.appAccess ? (
                      <Badge label="No app access" tone="exception" />
                    ) : undefined
                  }
                  onPress={() => push('assignmentDetail', { id: w.id })}
                />
              )
            })}
          </List>
        </DataState>
      </Section>

      <Section
        title="Coverage by machine"
        detail={
          uncoveredMachines.length > 0
            ? `${uncoveredMachines.length} active machine${uncoveredMachines.length === 1 ? ' has' : 's have'} nobody assigned`
            : 'Every active machine has at least one worker'
        }
      >
        <DataState
          loading={d.machinesApi.loading || d.usersApi.loading}
          error={d.machinesApi.error || d.usersApi.error}
          onRetry={d.reloadAll}
          hasData={!!d.machinesApi.data && !!d.usersApi.data}
          empty={!!d.machinesApi.data && activeMachines.length === 0}
          emptyText="No active machines configured"
          emptyIcon="construct-outline"
        >
          <List>
            {activeMachines.map((m) => {
              const assignedWorkers = workersByMachine.get(m.id) ?? []
              const uncovered = assignedWorkers.length === 0
              return (
                <Row
                  key={m.id}
                  title={m.name}
                  subtitle={uncovered ? 'Nobody is assigned — scheduled checks here reach nobody' : facts(m.code, assignedWorkers.map((w) => w.name).join(', '))}
                  right={uncovered ? <Badge label="No worker" tone="exception" /> : undefined}
                />
              )
            })}
          </List>
        </DataState>
      </Section>
    </Screen>
  )
}

/** One worker's machines: change the assignment, remove all, or send a test alert. */
export const AssignmentDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('assignments', 'manage')
  const d = useAssignmentData()
  const worker = d.workers.find((w) => w.id === params.id) ?? null

  const [draft, setDraft] = useState<string[] | null>(null)
  const [search, setSearch] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const selected = draft ?? worker?.machineIds ?? []
  const assigned = (worker?.machineIds ?? []).map((id) => d.machineById.get(id)).filter((m): m is Machine => !!m)
  const scheduleCount = d.schedules.filter((s) => s.workerId === params.id).length
  const lostSchedules = d.schedules.filter((s) => s.workerId === params.id && worker && !worker.machineIds.includes(s.machineId))

  const machineItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return d.machines
      .filter((m) => m.isActive || selected.includes(m.id))
      .map((m) => ({ id: m.id, label: m.isActive ? m.name : `${m.name} (disabled)`, detail: [m.departmentName, m.code].filter(Boolean).join(' · ') }))
      .filter((m) => !q || `${m.label} ${m.detail}`.toLowerCase().includes(q))
  }, [d.machines, selected, search])

  const toggle = (id: string) => setDraft(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  /** Sends a notification to the worker's registered apps and browsers so the admin can verify alerts. */
  const sendTestAlert = async () => {
    if (!worker) return
    setTesting(true)
    try {
      const { devices, browsers = 0, lastStatus } = await api.post<{ devices: number; browsers?: number; lastStatus?: AlertStatusReport | null }>(
        `/api/users/${worker.id}/test-notification`
      )
      let result: TestResult
      if (devices > 0) {
        const phones = devices - browsers
        const parts = [phones && `${phones} app${phones === 1 ? '' : 's'}`, browsers && `${browsers} browser${browsers === 1 ? '' : 's'}`].filter(Boolean)
        result = { kind: 'success', title: 'Test notification sent', message: `${worker.name}: ${parts.join(' and ')}.` }
      } else {
        result = { kind: 'warning', title: 'No device registered', message: noDeviceReason(worker.name, lastStatus) }
      }
      setTestResult(result)
      notify(result.kind, result.title, result.message)
    } catch (err) {
      setTestResult({ kind: 'error', title: 'Could not send', message: errorText(err) })
      notify('error', 'Could not send', errorText(err))
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!worker) return
    setSaving(true)
    setFormError(null)
    try {
      await api.put(`/api/users/${worker.id}/machines`, { machineIds: selected })
      notify(
        'success',
        'Assignment saved',
        selected.length
          ? `${worker.name} now covers ${selected.length} machine${selected.length === 1 ? '' : 's'}.`
          : `${worker.name} has no machines and will receive no checks.`
      )
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const removeAll = async () => {
    if (!worker) return
    const ok = await confirm(
      'Remove all machines',
      `Remove every machine from ${worker.name} (${worker.employeeId})? They will stop receiving any checks or notifications on the mobile app until a machine is assigned again.`,
      'Remove all',
      true
    )
    if (!ok) return
    setClearing(true)
    try {
      await api.put(`/api/users/${worker.id}/machines`, { machineIds: [] })
      notify('success', 'Assignments removed', `${worker.name} no longer receives any checks or notifications.`)
      setDraft(null)
      await d.usersApi.reload()
    } catch (err) {
      notify('error', 'Could not remove assignments', errorText(err))
    } finally {
      setClearing(false)
    }
  }

  const toneOf = { success: 'success', warning: 'exception', error: 'missed' } as const

  return (
    <Screen
      title={canEdit ? 'Change machine assignment' : 'Machine assignment'}
      onRefresh={d.reloadAll}
      refreshing={d.loading && d.hasData}
      footer={canEdit && worker ? <PrimaryButton label="Save Assignment" onPress={save} loading={saving} disabled={clearing} /> : undefined}
    >
      <DataState
        loading={d.loading}
        error={d.error}
        onRetry={d.reloadAll}
        hasData={d.hasData}
        empty={d.hasData && !worker}
        emptyText="This worker could not be found."
        emptyIcon="person-outline"
      >
        {worker ? (
          <>
            <SummaryHeader
              leading={<Initials name={worker.name} size="lg" muted={!worker.isActive} />}
              title={worker.name}
              caption={facts(`ID ${worker.employeeId}`, assigned.length ? `${assigned.length} machine${assigned.length === 1 ? '' : 's'}` : null)}
              status={
                !worker.isActive
                  ? { label: 'Disabled', tone: 'missed' }
                  : assigned.length === 0
                    ? { label: 'No machine', tone: 'exception' }
                    : !worker.appAccess
                      ? { label: 'No app access', tone: 'exception' }
                      : null
              }
            />
            <Card>
              <KV label="Employee ID" value={worker.employeeId} />
              <KV label="Designation" value={worker.designation} />
              <KV label="Shift" value={worker.shiftName} />
              <KV label="Department" value={worker.departmentName} />
              <KV label="Schedules" value={scheduleCount > 0 ? scheduleCount : null} />
            </Card>

            {lostSchedules.length > 0 ? (
              <Notice
                tone="missed"
                title={`${lostSchedules.length} schedule${lostSchedules.length === 1 ? '' : 's'} point at this worker but not their machines`}
                message="This worker is not assigned to the machine, so they will not receive these checks. Either assign the machine to the worker, or change the schedule."
              >
                <WarningLines
                  lines={lostSchedules.map((s) => ({
                    key: s.id,
                    node: (
                      <>
                        <Text className="font-semibold text-staff-ink">{s.machineName}</Text> · {s.activityName} · {s.shiftName}
                      </>
                    )
                  }))}
                />
              </Notice>
            ) : null}

            {canEdit ? (
              <View className="gap-3">
                <ActionGroup>
                  <ActionItem
                    label="Test alert"
                    description="Send a test notification to this worker's phone"
                    onPress={sendTestAlert}
                    disabled={testing}
                    right={testing ? <ActivityIndicator color={ICON_COLOR.muted} /> : null}
                  />
                </ActionGroup>
                {testResult ? <Notice tone={toneOf[testResult.kind]} title={testResult.title} message={testResult.message} /> : null}
              </View>
            ) : null}

            {canEdit ? (
              <Section
                title="Machines"
                detail={`${selected.length} selected`}
                action={
                  <View className="flex-row">
                    <SmallButton label="Select all" tone="ghost" onPress={() => setDraft(d.activeMachines.map((m) => m.id))} disabled={d.activeMachines.length === 0} />
                    <SmallButton label="Clear" tone="ghost" onPress={() => setDraft([])} disabled={selected.length === 0} />
                  </View>
                }
              >
                <View className="gap-3">
                  <FormError message={formError} />
                  {d.machines.length > 8 ? <SearchField value={search} onChangeText={setSearch} placeholder="Search machines" /> : null}
                  {machineItems.length === 0 ? (
                    <Card>
                      <Text className="px-4 py-6 text-center text-[15px] text-staff-muted">{search ? 'No matches' : 'No machines configured yet'}</Text>
                    </Card>
                  ) : (
                    <Card>
                      {machineItems.map((m, i) => {
                        const on = selected.includes(m.id)
                        return (
                          <Pressable
                            key={m.id}
                            onPress={() => toggle(m.id)}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: on }} aria-checked={on}
                            accessibilityLabel={m.label}
                            className={`min-h-[56px] flex-row items-center gap-3 px-4 py-2.5 active:bg-staff-fill ${i > 0 ? 'border-t border-staff-line' : ''}`}
                          >
                            <View className={`h-6 w-6 items-center justify-center rounded-md border ${on ? 'border-staff-primary bg-staff-primary' : 'border-staff-field bg-staff-card'}`}>
                              {on ? <Icon name="checkmark" size={16} color="white" /> : null}
                            </View>
                            <View className="flex-1">
                              <Text className={`text-[15px] leading-[20px] text-staff-ink ${on ? 'font-semibold' : ''}`}>{m.label}</Text>
                              {m.detail ? <Text className="text-[13px] leading-[17px] text-staff-muted">{m.detail}</Text> : null}
                            </View>
                          </Pressable>
                        )
                      })}
                    </Card>
                  )}
                  <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">The worker only sees checks, submits and gets notifications for these machines.</Text>
                </View>
              </Section>
            ) : (
              <Section title="Assigned machines">
                {assigned.length ? (
                  <List>
                    {assigned.map((m) => (
                      <Row
                        key={m.id}
                        title={m.isActive ? m.name : `${m.name} (disabled)`}
                        subtitle={[m.departmentName, m.code].filter(Boolean).join(' · ')}
                      />
                    ))}
                  </List>
                ) : (
                  <Notice tone="exception" title="Not assigned — receives nothing" />
                )}
              </Section>
            )}

            {canEdit && assigned.length > 0 ? (
              <ActionGroup>
                <ActionItem
                  label="Remove all"
                  description={clearing ? 'Removing…' : 'Stops all checks and notifications for this worker'}
                  tone="danger"
                  onPress={removeAll}
                  disabled={saving || clearing}
                />
              </ActionGroup>
            ) : null}
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

export const ASSIGNMENTS_SCREENS = {
  assignments: AssignmentsScreen,
  assignmentDetail: AssignmentDetailScreen
}
