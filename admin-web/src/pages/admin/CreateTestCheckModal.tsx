import React, { useEffect, useMemo, useState } from 'react'
import type { Activity, Machine, QualityCheck, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { formatDateTime } from '../../lib/format'
import { Modal } from '../../components/common/Modal'
import { Button } from '../../components/common/Button'
import { Field, FormError, Select, TextInput } from '../../components/common/Form'
import { useToast } from '../../components/common/Toast'

interface Props {
  isOpen: boolean
  onClose: () => void
  onCreated: (check: QualityCheck) => void
}

type TestStatus = 'DUE' | 'PENDING'

const WINDOW_OPTIONS = [15, 30, 60, 120, 240, 480]

/** Value for <input type="datetime-local"> in local time. */
function localInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function inMinutes(minutes: number) {
  const d = new Date(Date.now() + minutes * 60_000)
  d.setSeconds(0, 0)
  return d
}

export const CreateTestCheckModal: React.FC<Props> = ({ isOpen, onClose, onCreated }) => {
  const notify = useToast()
  const machines = useApi<Machine[]>(isOpen ? '/api/machines' : null)
  const activities = useApi<Activity[]>(isOpen ? '/api/activities' : null)
  const workers = useApi<User[]>(isOpen ? '/api/users' : null, { role: 'WORKER' })

  const [workerId, setWorkerId] = useState('')
  const [machineId, setMachineId] = useState('')
  const [activityId, setActivityId] = useState('')
  const [status, setStatus] = useState<TestStatus>('DUE')
  const [startAt, setStartAt] = useState(() => localInputValue(inMinutes(60)))
  const [windowMinutes, setWindowMinutes] = useState(60)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const activeWorkers = useMemo(() => (workers.data ?? []).filter((w) => w.isActive && w.appAccess), [workers.data])
  const selectedWorker = activeWorkers.find((w) => w.id === workerId)
  const activeMachines = useMemo(() => (machines.data ?? []).filter((m) => m.isActive), [machines.data])
  const machine = activeMachines.find((m) => m.id === machineId)
  const activeActivities = useMemo(() => (activities.data ?? []).filter((a) => a.isActive), [activities.data])
  const linkedActivities = activeActivities.filter((a) => machine?.activityIds.includes(a.id))
  const otherActivities = activeActivities.filter((a) => !machine?.activityIds.includes(a.id))

  // Reset the form each time the modal opens.
  useEffect(() => {
    if (!isOpen) return
    setStatus('DUE')
    setStartAt(localInputValue(inMinutes(60)))
    setWindowMinutes(60)
    setError(null)
  }, [isOpen])

  // Sensible defaults once lists load: first worker, one of their machines, a check type on that machine.
  useEffect(() => {
    if (!isOpen || workerId || activeWorkers.length === 0) return
    setWorkerId(activeWorkers[0].id)
  }, [isOpen, workerId, activeWorkers])

  useEffect(() => {
    if (!isOpen || machineId || activeMachines.length === 0) return
    const preferred = activeMachines.find((m) => selectedWorker?.machineIds.includes(m.id)) ?? activeMachines[0]
    setMachineId(preferred.id)
  }, [isOpen, machineId, activeMachines, selectedWorker])

  useEffect(() => {
    if (!machine || activeActivities.length === 0) return
    if (activityId && activeActivities.some((a) => a.id === activityId)) return
    setActivityId((linkedActivities[0] ?? activeActivities[0]).id)
  }, [machine, activityId, activeActivities, linkedActivities])

  const start = status === 'DUE' ? new Date() : new Date(startAt)
  const startValid = status === 'DUE' || (!Number.isNaN(start.getTime()) && start.getTime() > Date.now())
  const closesAt = new Date(start.getTime() + windowMinutes * 60_000)
  const workerLacksAccess = selectedWorker && machine && !selectedWorker.machineIds.includes(machine.id)

  const submit = async () => {
    setError(null)
    if (!machineId || !activityId) {
      setError('Choose a machine and a check type')
      return
    }
    if (!startValid) {
      setError('A pending check must start in the future')
      return
    }
    setSaving(true)
    try {
      const check = await api.post<QualityCheck>('/api/quality-checks', {
        machineId,
        activityId,
        workerId: workerId || null,
        status,
        scheduledAt: status === 'PENDING' ? start.toISOString() : undefined,
        windowMinutes
      })
      const who = selectedWorker ? `${selectedWorker.name}'s phone` : 'the phones of workers with access to this machine'
      notify(
        'success',
        `Test check ${check.code} created`,
        status === 'DUE' ? `It shows now on ${who} under "Do now".` : `It shows on ${who} under "Later today" and opens 30 minutes before the start time.`
      )
      onCreated(check)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const listsError = machines.error ?? activities.error ?? workers.error

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create test check"
      subtitle="Send a one-off check to the worker app to test photo, video, submit and exception"
      maxWidth="lg"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit} loading={saving} disabled={!machineId || !activityId}>
            Create check
          </Button>
        </>
      }
    >
      <FormError message={error ?? listsError} />

      {/* A fieldset, not a <label>: a label would give its name to the first button. */}
      <fieldset>
        <legend className="block text-[13px] lg:text-xs font-semibold text-slate-700 mb-1">
          Start<span className="text-failed"> *</span>
        </legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Start">
          {(
            [
              { value: 'DUE', title: 'Start now', text: 'Opens immediately on the phone' },
              { value: 'PENDING', title: 'Start later', text: 'Opens at a start time you choose' }
            ] as const
          ).map((option) => {
            const active = status === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setStatus(option.value)}
                className={`text-left px-3 py-2.5 rounded border transition-colors ${
                  active ? 'border-accent bg-blue-50 ring-1 ring-accent' : 'border-line-strong bg-white hover:bg-slate-50'
                }`}
              >
                <span className={`block text-xs font-semibold ${active ? 'text-accent' : 'text-ink'}`}>{option.title}</span>
                <span className="block text-[11px] text-ink-muted mt-0.5">{option.text}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Worker" hint={workerLacksAccess ? 'This worker is not assigned to this machine, but the check is assigned to them directly.' : undefined}>
          <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">Automatic: worker on the current shift</option>
            {activeWorkers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.employeeId})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Machine" required>
          <Select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {activeMachines.length === 0 && <option value="">No active machines</option>}
            {activeMachines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.code}){m.status !== 'ACTIVE' ? ` · ${m.status.toLowerCase()}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Check type" required hint="The worker sees the parameters and photo/video rules of this check type.">
        <Select value={activityId} onChange={(e) => setActivityId(e.target.value)}>
          {activeActivities.length === 0 && <option value="">No active check types</option>}
          {linkedActivities.length > 0 && (
            <optgroup label="On this machine">
              {linkedActivities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.parameters.filter((p) => p.isEnabled).length} parameters)
                </option>
              ))}
            </optgroup>
          )}
          {otherActivities.length > 0 && (
            <optgroup label={linkedActivities.length ? 'Other check types' : 'Check types'}>
              {otherActivities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.parameters.filter((p) => p.isEnabled).length} parameters)
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {status === 'PENDING' ? (
          <Field label="Start time" required error={startValid ? null : 'Choose a time in the future'}>
            <TextInput type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </Field>
        ) : (
          <Field label="Start time">
            <TextInput value="Now" disabled />
          </Field>
        )}

        <Field label="Open for">
          <Select value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))}>
            {WINDOW_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {startValid && (
        <div className="px-3 py-2 rounded border border-line bg-slate-50 text-[11px] text-ink-secondary">
          {status === 'DUE' ? 'Opens now' : `Opens at ${formatDateTime(start.toISOString())}`}, then marked{' '}
          <span className="font-semibold text-missed">Missed</span> if not submitted by{' '}
          <span className="font-semibold text-ink">{formatDateTime(closesAt.toISOString())}</span>.
        </div>
      )}
    </Modal>
  )
}
