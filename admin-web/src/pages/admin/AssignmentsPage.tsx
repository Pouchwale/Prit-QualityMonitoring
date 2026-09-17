import React, { useMemo, useState } from 'react'
import { AlertTriangle, Bell, Info, Link2, Search, Users, XCircle } from 'lucide-react'
import type { Machine, Schedule, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { FormError, MultiSelectList, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { WorkerCoverageAlert } from '../../components/common/WorkerCoverageAlert'

/** A schedule that names a worker who is not assigned to that schedule's machine. */
interface BrokenSchedule {
  schedule: Schedule
  workerName: string
}

const MachineChip: React.FC<{ label: string; muted?: boolean }> = ({ label, muted }) => (
  <span
    className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-medium ${
      muted ? 'bg-slate-50 text-ink-muted border-line' : 'bg-subtle text-ink-secondary border-line'
    }`}
  >
    {label}
  </span>
)

interface AlertStatusReport {
  status: string
  platform: string | null
  detail: string | null
  at: string
}

/**
 * Why a worker has no registered device, from what their device last reported when it tried to
 * turn on alerts, with the step that fixes it.
 */
function noDeviceReason(name: string, report: AlertStatusReport | null | undefined) {
  if (!report) {
    return `${name} has not opened an app version that can register for alerts. Ask them to sign in again to the Android app or the worker web app.`
  }
  const device = report.platform ? ` (${report.platform}, ${new Date(report.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })})` : ''
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

export const AssignmentsPage: React.FC = () => {
  const canEdit = useCanManage('assignments')
  const notify = useToast()
  const [testing, setTesting] = useState<string | null>(null)

  /** Sends a notification to the worker's registered apps and browsers so the admin can verify alerts. */
  const sendTestAlert = async (worker: User) => {
    setTesting(worker.id)
    try {
      const { devices, browsers = 0, lastStatus } = await api.post<{ devices: number; browsers?: number; lastStatus?: AlertStatusReport | null }>(
        `/api/users/${worker.id}/test-notification`
      )
      if (devices > 0) {
        const phones = devices - browsers
        const parts = [phones && `${phones} app${phones === 1 ? '' : 's'}`, browsers && `${browsers} browser${browsers === 1 ? '' : 's'}`].filter(Boolean)
        notify('success', 'Test notification sent', `${worker.name}: ${parts.join(' and ')}.`)
      } else {
        notify('warning', 'No device registered', noDeviceReason(worker.name, lastStatus))
      }
    } catch (err) {
      notify('error', 'Could not send', errorText(err))
    } finally {
      setTesting(null)
    }
  }
  const usersApi = useApi<User[]>('/api/users', { role: 'WORKER' })
  const machinesApi = useApi<Machine[]>('/api/machines')
  const schedulesApi = useApi<Schedule[]>('/api/schedules')

  const [search, setSearch] = useState('')
  const [onlyUnassigned, setOnlyUnassigned] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState<User | null>(null)

  const workers = useMemo(() => usersApi.data ?? [], [usersApi.data])
  const machines = useMemo(() => machinesApi.data ?? [], [machinesApi.data])
  const schedules = useMemo(() => schedulesApi.data ?? [], [schedulesApi.data])

  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])
  const activeMachines = useMemo(() => machines.filter((m) => m.isActive), [machines])

  /** How many schedules name each worker directly. */
  const schedulesByWorker = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of schedules) {
      if (!s.workerId) continue
      counts.set(s.workerId, (counts.get(s.workerId) ?? 0) + 1)
    }
    return counts
  }, [schedules])

  const unassignedWorkers = useMemo(() => workers.filter((w) => w.isActive && w.machineIds.length === 0), [workers])

  /** Active machines with nobody assigned: scheduled checks there reach nobody. */
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
  const broken = useMemo<BrokenSchedule[]>(() => {
    const byId = new Map(workers.map((w) => [w.id, w]))
    const rows: BrokenSchedule[] = []
    for (const s of schedules) {
      if (!s.workerId) continue
      const worker = byId.get(s.workerId)
      if (!worker) continue
      if (worker.machineIds.includes(s.machineId)) continue
      rows.push({ schedule: s, workerName: worker.name })
    }
    return rows
  }, [schedules, workers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return workers.filter((w) => {
      if (onlyUnassigned && w.machineIds.length > 0) return false
      if (!q) return true
      const machineNames = w.machineIds.map((id) => machineById.get(id)?.name ?? '').join(' ')
      return [w.name, w.employeeId, w.designation, w.shiftName, w.departmentName, machineNames].some((v) =>
        v?.toLowerCase().includes(q)
      )
    })
  }, [workers, search, onlyUnassigned, machineById])

  const openEdit = (worker: User) => {
    setSelected(worker.machineIds)
    setFormError(null)
    setEditing(worker)
  }

  const saveAssignment = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!editing) return
    setSaving(true)
    setFormError(null)
    try {
      await api.put(`/api/users/${editing.id}/machines`, { machineIds: selected })
      notify(
        'success',
        'Assignment saved',
        selected.length
          ? `${editing.name} now covers ${selected.length} machine${selected.length === 1 ? '' : 's'}.`
          : `${editing.name} has no machines and will receive no checks.`
      )
      setEditing(null)
      usersApi.reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const removeAll = async () => {
    if (!clearing) return
    try {
      await api.put(`/api/users/${clearing.id}/machines`, { machineIds: [] })
      notify('success', 'Assignments removed', `${clearing.name} no longer receives any checks or notifications.`)
      usersApi.reload()
    } catch (err) {
      notify('error', 'Could not remove assignments', errorText(err))
    }
  }

  const machineItems = useMemo(
    () =>
      machines
        .filter((m) => m.isActive || selected.includes(m.id))
        .map((m) => ({
          id: m.id,
          label: m.isActive ? m.name : `${m.name} (disabled)`,
          detail: [m.departmentName, m.code].filter(Boolean).join(' · ')
        })),
    [machines, selected]
  )

  const loading = usersApi.loading || machinesApi.loading || schedulesApi.loading
  const loadError = usersApi.error || machinesApi.error || schedulesApi.error
  const reloadAll = () => {
    usersApi.reload()
    machinesApi.reload()
    schedulesApi.reload()
  }

  const uncoveredMachines = activeMachines.filter((m) => (workersByMachine.get(m.id) ?? []).length === 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Machine Assignment"
        description="The machine assignment decides everything a worker sees: a worker only sees, submits and is notified about quality checks for the machines assigned to them. If a worker is not assigned to a machine, checks for that machine never reach their phone, even if a schedule names them."
      />

      <WorkerCoverageAlert
        gaps={(schedulesApi.data ?? [])
          .filter((s) => s.isActive && s.checkWorkers.length === 0)
          .map((s) => ({ scheduleId: s.id, machineName: s.machineName, shiftName: s.shiftName, activityName: s.activityName }))}
      />

      {unassignedWorkers.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-exception-line bg-exception-bg text-xs">
          <AlertTriangle className="w-4 h-4 text-exception shrink-0 mt-px" />
          <div>
            <div className="font-semibold text-exception">
              {unassignedWorkers.length} active worker{unassignedWorkers.length === 1 ? ' has' : 's have'} no machine
            </div>
            <div className="text-ink-secondary mt-0.5">
              They receive nothing on the mobile app. Assign at least one machine to:{' '}
              <span className="font-medium text-ink">{unassignedWorkers.map((w) => w.name).join(', ')}</span>
            </div>
          </div>
        </div>
      )}

      {broken.length > 0 && (
        <div className="rounded-md border border-failed-line bg-failed-bg overflow-hidden">
          <div className="flex items-start gap-2 px-3 py-2.5 border-b border-failed-line">
            <XCircle className="w-4 h-4 text-failed shrink-0 mt-px" />
            <div className="text-xs">
              <div className="font-semibold text-failed">
                {broken.length} schedule{broken.length === 1 ? '' : 's'} point at a worker who lost the machine
              </div>
              <div className="text-ink-secondary mt-0.5">
                This worker is not assigned to the machine, so they will not receive these checks. Either assign the machine
                to the worker below, or change the schedule.
              </div>
            </div>
          </div>
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-white/60 border-b border-failed-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3.5">Machine</th>
                <th className="py-2 px-3.5">Check type</th>
                <th className="py-2 px-3.5">Shift</th>
                <th className="py-2 px-3.5">Worker</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-failed-line">
              {broken.map(({ schedule, workerName }) => (
                <tr key={schedule.id}>
                  <td className="py-2 px-3.5 font-semibold text-ink whitespace-nowrap">{schedule.machineName}</td>
                  <td className="py-2 px-3.5 text-slate-700 whitespace-nowrap">{schedule.activityName}</td>
                  <td className="py-2 px-3.5 text-slate-700 whitespace-nowrap">{schedule.shiftName}</td>
                  <td className="py-2 px-3.5 whitespace-nowrap">
                    <span className="font-medium text-failed">{workerName}</span>
                    {schedule.workerEmployeeId && (
                      <span className="ml-1.5 font-mono text-[11px] text-ink-muted">{schedule.workerEmployeeId}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 border border-line rounded-md shadow-2xs text-xs">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 lg:top-2.5 lg:translate-y-0 text-ink-faint pointer-events-none" />
          <input
            type="text"
            placeholder="Search worker, employee ID, machine…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-[40px] lg:h-8 pl-8 pr-3 border border-line-strong rounded text-[16px] lg:text-xs bg-white placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <Toggle
          checked={onlyUnassigned}
          onChange={setOnlyUnassigned}
          label="Show only unassigned"
          description="Workers with no machine at all"
        />
      </div>

      <DataState
        loading={loading}
        error={loadError}
        onRetry={reloadAll}
        empty={!loading && filtered.length === 0}
        emptyText={workers.length === 0 ? 'No workers yet' : 'No workers match the filters'}
      >
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Worker</th>
                <th className="py-2.5 px-3.5">Designation</th>
                <th className="py-2.5 px-3.5">Shift</th>
                <th className="py-2.5 px-3.5">Status</th>
                <th className="py-2.5 px-3.5">Assigned machines</th>
                <th className="py-2.5 px-3.5">Schedules</th>
                {canEdit && <th className="py-2.5 px-3.5 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((w) => {
                const assigned = w.machineIds.map((id) => machineById.get(id)).filter((m): m is Machine => !!m)
                const scheduleCount = schedulesByWorker.get(w.id) ?? 0
                return (
                  <tr key={w.id} className="hover:bg-slate-50 transition-colors align-top">
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <span className={`font-semibold ${w.isActive ? 'text-ink' : 'text-ink-muted'}`}>{w.name}</span>
                      <span className="block font-mono text-[11px] text-ink-muted">{w.employeeId}</span>
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">
                      {w.designation ?? <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">
                      {w.shiftName ?? <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <StatusBadge status={w.isActive ? 'ACTIVE' : 'DISABLED'} size="sm" />
                      {!w.appAccess && <span className="block text-[11px] text-exception mt-1">No app access</span>}
                    </td>
                    <td className="py-2.5 px-3.5 min-w-[240px]">
                      {assigned.length ? (
                        <div className="flex flex-wrap gap-1">
                          {assigned.map((m) => (
                            <MachineChip key={m.id} label={m.name} muted={!m.isActive} />
                          ))}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-exception font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Not assigned — receives nothing
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">
                      {scheduleCount > 0 ? scheduleCount : <span className="text-ink-faint">—</span>}
                    </td>
                    {canEdit && (
                      <td className="py-2 px-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openEdit(w)}
                            icon={<Link2 className="w-3 h-3 text-ink-muted" />}
                          >
                            Change
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            loading={testing === w.id}
                            onClick={() => sendTestAlert(w)}
                            icon={<Bell className="w-3 h-3 text-ink-muted" />}
                            title="Send a test notification to this worker's phone"
                          >
                            Test alert
                          </Button>
                          {assigned.length > 0 && (
                            <Button size="sm" variant="ghost" onClick={() => setClearing(w)}>
                              Remove all
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DataState>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-ink-muted" />
          <h2 className="text-sm font-semibold text-ink">Coverage by machine</h2>
          <span className="text-[11px] text-ink-muted">
            {uncoveredMachines.length > 0
              ? `${uncoveredMachines.length} active machine${uncoveredMachines.length === 1 ? ' has' : 's have'} nobody assigned`
              : 'Every active machine has at least one worker'}
          </span>
        </div>
        <DataState
          loading={machinesApi.loading || usersApi.loading}
          error={machinesApi.error || usersApi.error}
          onRetry={reloadAll}
          empty={!machinesApi.loading && activeMachines.length === 0}
          emptyText="No active machines configured"
        >
          <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
            <table className="stack-sm w-full text-left text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3.5">Machine</th>
                  <th className="py-2.5 px-3.5">Code</th>
                  <th className="py-2.5 px-3.5">Department</th>
                  <th className="py-2.5 px-3.5">Assigned workers</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {activeMachines.map((m) => {
                  const assignedWorkers = workersByMachine.get(m.id) ?? []
                  const uncovered = assignedWorkers.length === 0
                  return (
                    <tr key={m.id} className={uncovered ? 'bg-exception-bg' : 'hover:bg-slate-50 transition-colors'}>
                      <td className="py-2.5 px-3.5 whitespace-nowrap font-semibold text-ink">{m.name}</td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap font-mono text-ink-secondary">{m.code}</td>
                      <td className="py-2.5 px-3.5 whitespace-nowrap text-slate-700">
                        {m.departmentName ?? <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="py-2.5 px-3.5 min-w-[240px]">
                        {uncovered ? (
                          <span className="inline-flex items-center gap-1 text-exception font-medium">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Nobody is assigned — scheduled checks here reach nobody
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {assignedWorkers.map((w) => (
                              <MachineChip key={w.id} label={w.name} />
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </DataState>
      </div>

      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        title="Change machine assignment"
        subtitle={editing ? `${editing.name} · ${editing.employeeId}` : undefined}
        maxWidth="lg"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="assignment-form" loading={saving}>
              Save Assignment
            </Button>
          </>
        }
      >
        <form id="assignment-form" onSubmit={saveAssignment} className="space-y-3">
          <FormError message={formError} />
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold text-slate-700">Machines</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-muted">{selected.length} selected</span>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setSelected(activeMachines.map((m) => m.id))}
                disabled={activeMachines.length === 0}
              >
                Select all
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setSelected([])} disabled={selected.length === 0}>
                Clear
              </Button>
            </div>
          </div>
          <MultiSelectList
            items={machineItems}
            selected={selected}
            onChange={setSelected}
            emptyText={machinesApi.loading ? 'Loading machines…' : 'No machines configured yet'}
          />
          <div className="flex items-start gap-1.5 text-[11px] text-ink-muted">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>The worker only sees checks, submits and gets notifications for these machines.</span>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={clearing !== null}
        title="Remove all machines"
        danger
        confirmLabel="Remove all"
        message={
          <>
            Remove every machine from <span className="font-semibold text-ink">{clearing?.name}</span> ({clearing?.employeeId})?
            They will stop receiving any checks or notifications on the mobile app until a machine is assigned again.
          </>
        }
        onConfirm={removeAll}
        onClose={() => setClearing(null)}
      />
    </div>
  )
}
