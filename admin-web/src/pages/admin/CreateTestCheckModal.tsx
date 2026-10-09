import React, { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Info, Zap } from 'lucide-react'
import type { Activity, Machine, QualityCheck, User } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { formatDateTime, fromPlantInput, toPlantInput } from '../../lib/format'
import { Modal } from '../../components/common/Modal'
import { Button } from '../../components/common/Button'
import { Field, FormError, Select, TextInput } from '../../components/common/Form'
import { useToast } from '../../components/common/Toast'
import { DateInput, TimeInput } from '../../components/common/DateTimeInputs'

interface Props {
  isOpen: boolean
  onClose: () => void
  onCreated: (check: QualityCheck) => void
}

type TestStatus = 'DUE' | 'PENDING'

const WINDOW_OPTIONS = [15, 30, 60, 120, 240, 480]

/** The plant's date and time as YYYY-MM-DDTHH:MM (what the date and time fields edit). */
const localInputValue = toPlantInput

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
    const preferred = activeMachines[0]
    setMachineId(preferred.id)
  }, [isOpen, machineId, activeMachines, selectedWorker])

  useEffect(() => {
    if (!machine || activeActivities.length === 0) return
    if (activityId && activeActivities.some((a) => a.id === activityId)) return
    setActivityId((linkedActivities[0] ?? activeActivities[0]).id)
  }, [machine, activityId, activeActivities, linkedActivities])

  // The fields hold the plant's wall-clock time, whatever the browser's time zone.
  const start = status === 'DUE' ? new Date() : fromPlantInput(startAt)
  const startValid = status === 'DUE' || (!Number.isNaN(start.getTime()) && start.getTime() > Date.now())
  const closesAt = new Date(start.getTime() + windowMinutes * 60_000)

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
        <legend className="block text-[13px] lg:text-[12.5px] font-medium text-ink-secondary mb-1.5">
          Start
          <span className="text-missed" aria-hidden>
            {' '}
            *
          </span>
          <span className="sr-only"> (required)</span>
        </legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Start">
          {(
            [
              { value: 'DUE', title: 'Start now', text: 'Opens immediately on the phone', icon: <Zap className="w-4 h-4" /> },
              { value: 'PENDING', title: 'Start later', text: 'Opens at a start time you choose', icon: <CalendarClock className="w-4 h-4" /> }
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
                className={`flex items-start gap-2.5 text-left px-3 py-2.5 rounded-lg border transition-colors ${
                  active ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line-strong bg-white hover:bg-subtle'
                }`}
              >
                <span
                  className={`mt-px w-7 h-7 shrink-0 rounded-md flex items-center justify-center ${active ? 'bg-white text-accent ring-1 ring-accent-line' : 'bg-subtle text-ink-secondary'}`}
                  aria-hidden
                >
                  {option.icon}
                </span>
                <span className="min-w-0">
                  <span className={`block text-[13px] lg:text-[12.5px] font-semibold ${active ? 'text-accent-strong' : 'text-ink'}`}>{option.title}</span>
                  <span className="block text-[11.5px] text-ink-muted mt-0.5">{option.text}</span>
                </span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Worker" hint="Leave on automatic to give the check to whoever is running the job on this machine.">
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
            <span className="flex flex-wrap items-center gap-1.5">
              <DateInput
                aria-label="Start date"
                value={startAt.slice(0, 10)}
                onChange={(e) => e.target.value && setStartAt(`${e.target.value}T${startAt.slice(11, 16)}`)}
                className="w-[140px]"
              />
              <TimeInput label="Start time" value={startAt.slice(11, 16)} onChange={(v) => setStartAt(`${startAt.slice(0, 10)}T${v}`)} />
            </span>
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
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-line bg-subtle text-[12px] text-ink-secondary" role="status">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden />
          <span>
            {status === 'DUE' ? 'Opens now' : `Opens at ${formatDateTime(start.toISOString())}`}, then marked{' '}
            <span className="font-semibold text-missed">Missed</span> if not submitted by{' '}
            <span className="font-semibold text-ink">{formatDateTime(closesAt.toISOString())}</span>.
          </span>
        </div>
      )}
    </Modal>
  )
}
