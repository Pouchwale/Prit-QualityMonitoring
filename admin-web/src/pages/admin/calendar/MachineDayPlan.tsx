import React, { useMemo, useState } from 'react'
import { Cog, Pencil, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import type { Machine, MachineDayPlan } from '../../../types'
import { api, errorText } from '../../../lib/api'
import { useApi } from '../../../lib/useApi'
import { Button } from '../../../components/common/Button'
import { ConfirmModal } from '../../../components/common/ConfirmModal'
import { Field, FormError, TextInput } from '../../../components/common/Form'
import { Modal } from '../../../components/common/Modal'
import { useToast } from '../../../components/common/Toast'
import { formatDateKey, formatLongDate } from '../../../lib/format'

const longDate = (key: string) => formatLongDate(key)
const shortDate = (key: string) => formatDateKey(key)

const removedText = (n: number) => (n > 0 ? `${n} open check${n === 1 ? '' : 's'} removed for machines that are not running.` : undefined)

/** Machine names, shortened to the first few with a "+N more" tail. */
function compactNames(names: string[], max = 4) {
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`
}

/**
 * "Machines running" on the selected day. A machine day plan lists exactly the machines that run
 * (even on a closed day); without one the plant calendar decides for every machine.
 */
export const MachinesRunningSection: React.FC<{
  date: string
  today: string
  /** The plant calendar closes this date (weekly off, holiday, shutdown…). */
  plantClosed: boolean
  plan: MachineDayPlan | null
  loading: boolean
  canEdit: boolean
  onChanged: () => void
}> = ({ date, today, plantClosed, plan, loading, canEdit, onChanged }) => {
  const notify = useToast()
  const machines = useApi<Machine[]>('/api/machines')
  const [picking, setPicking] = useState(false)
  const [resetting, setResetting] = useState(false)
  const past = date < today
  const active = useMemo(() => (machines.data ?? []).filter((m) => m.isActive), [machines.data])
  const total = active.length

  const reset = async () => {
    try {
      const result = await api.del<{ removed: boolean; removedChecks: number }>(`/api/machine-days/${date}`)
      notify('success', `${shortDate(date)} back to the default`, removedText(result?.removedChecks ?? 0) ?? 'The plant calendar decides which machines run on this date.')
      onChanged()
    } catch (err) {
      notify('error', 'Could not reset the machine plan', errorText(err))
    }
  }

  return (
    <div className="pt-3 mt-3 border-t border-line space-y-2.5" aria-label="Machines running" role="group">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
        <Cog className="w-3.5 h-3.5" aria-hidden /> Machines running
      </h3>
      {loading ? (
        <p className="text-xs text-ink-muted">Loading…</p>
      ) : plan ? (
        <div className="space-y-1.5">
          <div className="flex items-start gap-2 text-xs text-ink">
            <span className="mt-1 w-2 h-2 shrink-0 rounded-full bg-accent" aria-hidden />
            <span className="font-semibold">
              {plan.machineIds.length === 0
                ? 'No machines running · custom plan'
                : `${plan.machineIds.length}${total ? ` of ${total}` : ''} machine${plan.machineIds.length === 1 && !total ? '' : 's'} running · custom plan`}
            </span>
          </div>
          {plan.machines.length > 0 && (
            <p className="text-[11px] text-ink-secondary break-words" title={plan.machines.map((m) => m.name).join(', ')}>
              {compactNames(plan.machines.map((m) => m.name))}
            </p>
          )}
          {plan.note && <p className="text-[11px] text-ink-secondary italic break-words">“{plan.note}”</p>}
          <p className="text-[11px] text-ink-muted">
            Only these machines get checks and reminders on this date.
            {plan.updatedByName ? ` Set by ${plan.updatedByName}.` : ''}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-ink-secondary">
            <span className={`w-2 h-2 rounded-full ${plantClosed ? 'bg-ink-faint' : 'bg-success'}`} aria-hidden />
            {plantClosed ? 'Plant closed · no machines' : 'All machines (default)'}
          </div>
          <p className="text-[11px] text-ink-muted">
            {plantClosed ? 'Choose machines to run some of them on this closed day.' : 'Choose machines to run only some of them on this date.'}
          </p>
        </div>
      )}

      {canEdit && !loading &&
        (past ? (
          <p className="text-[11px] text-ink-faint">Past dates are read-only. Choose today or a later date to plan machines.</p>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={plan ? 'outline' : 'primary'}
              onClick={() => setPicking(true)}
              icon={plan ? <Pencil className="w-3.5 h-3.5" /> : <SlidersHorizontal className="w-3.5 h-3.5" />}
              className="flex-1"
            >
              {plan ? 'Edit machines' : 'Choose machines'}
            </Button>
            {plan && (
              <Button size="sm" variant="outline" onClick={() => setResetting(true)} icon={<RotateCcw className="w-3.5 h-3.5" />} className="flex-1">
                Reset to default
              </Button>
            )}
          </div>
        ))}

      {picking && (
        <MachinePickerModal
          date={date}
          plan={plan}
          plantClosed={plantClosed}
          machines={machines.data}
          machinesError={machines.error}
          onRetry={machines.reload}
          onClose={() => setPicking(false)}
          onSaved={(removedChecks, count) => {
            setPicking(false)
            notify('success', `Machine plan saved for ${shortDate(date)}`, removedText(removedChecks) ?? `${count} machine${count === 1 ? '' : 's'} running on this date.`)
            onChanged()
          }}
        />
      )}

      <ConfirmModal
        isOpen={resetting}
        title="Reset to default?"
        message={
          <>
            The machine plan for <span className="font-semibold text-ink">{longDate(date)}</span> is removed.{' '}
            {plantClosed ? 'The plant is closed on this date, so no machines run.' : 'Every machine runs as the plant calendar says.'}
          </>
        }
        confirmLabel="Reset to default"
        danger
        onConfirm={reset}
        onClose={() => setResetting(false)}
      />
    </div>
  )
}

const MachinePickerModal: React.FC<{
  date: string
  plan: MachineDayPlan | null
  plantClosed: boolean
  machines: Machine[] | null
  machinesError: string | null
  onRetry: () => void
  onClose: () => void
  onSaved: (removedChecks: number, count: number) => void
}> = ({ date, plan, plantClosed, machines, machinesError, onRetry, onClose, onSaved }) => {
  // Active machines, plus any planned machine that has since been deactivated (so it can be removed).
  const items = useMemo(() => {
    const list = (machines ?? []).filter((m) => m.isActive || plan?.machineIds.includes(m.id))
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [machines, plan])
  const [chosen, setChosen] = useState<Set<string> | null>(() => (plan ? new Set(plan.machineIds) : null))
  const [search, setSearch] = useState('')
  const [note, setNote] = useState(plan?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Without a plan the picker starts from today's default: every active machine on an open day, none on a closed day.
  const selected = chosen ?? new Set(plantClosed ? [] : items.filter((m) => m.isActive).map((m) => m.id))
  const q = search.trim().toLowerCase()
  const visible = q
    ? items.filter((m) => [m.name, m.code, m.departmentName ?? '', m.line ?? ''].some((v) => v.toLowerCase().includes(q)))
    : items

  const update = (next: Set<string>) => setChosen(next)
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    update(next)
  }
  const selectAll = () => update(new Set([...selected, ...visible.map((m) => m.id)]))
  const clear = () => {
    const next = new Set(selected)
    visible.forEach((m) => next.delete(m.id))
    update(next)
  }

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const machineIds = items.filter((m) => selected.has(m.id)).map((m) => m.id)
      const result = await api.put<{ plan: MachineDayPlan; removedChecks: number }>(`/api/machine-days/${date}`, {
        machineIds,
        note: note.trim() || null
      })
      onSaved(result.removedChecks ?? 0, machineIds.length)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const count = items.filter((m) => selected.has(m.id)).length

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={plan ? 'Edit machines running' : 'Choose machines running'}
      subtitle={`${longDate(date)} · only the machines switched on get checks and reminders`}
      maxWidth="lg"
      footer={
        <div className="flex w-full flex-col-reverse sm:flex-row sm:items-center gap-2">
          <span className="text-[11px] text-ink-muted sm:mr-auto" aria-live="polite">
            {count} of {items.length} machine{items.length === 1 ? '' : 's'} running
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 sm:flex-none">
              Cancel
            </Button>
            <Button type="submit" form="machine-plan-form" variant="primary" loading={saving} disabled={!machines} className="flex-1 sm:flex-none">
              Save
            </Button>
          </div>
        </div>
      }
    >
      <form id="machine-plan-form" onSubmit={save} className="space-y-3">
        <FormError message={error} />
        {count === 0 && machines && (
          <div className="px-3 py-2 rounded border border-exception-line bg-exception-bg text-[11px] text-ink-secondary">
            No machine is switched on: nothing runs on this date, so no checks or reminders are sent.
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            <TextInput
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search machines"
              aria-label="Search machines"
              className="pl-8"
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={selectAll} disabled={!visible.length} className="flex-1 sm:flex-none">
              Select all
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={clear} disabled={!visible.length} className="flex-1 sm:flex-none">
              Clear
            </Button>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto border border-line-strong rounded divide-y divide-line bg-white" role="group" aria-label="Machines">
          {machinesError ? (
            <div className="px-3 py-3 text-xs text-failed flex items-center justify-between gap-2">
              <span>{machinesError}</span>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : !machines ? (
            <div className="px-3 py-3 text-xs text-ink-muted">Loading machines…</div>
          ) : visible.length === 0 ? (
            <div className="px-3 py-3 text-xs text-ink-muted">{items.length ? 'No machines match the search' : 'No active machines'}</div>
          ) : (
            visible.map((m) => {
              const on = selected.has(m.id)
              return (
                <label key={m.id} className="flex items-center gap-2.5 px-3 py-2.5 lg:py-2 cursor-pointer hover:bg-slate-50">
                  <input type="checkbox" checked={on} onChange={() => toggle(m.id)} className="h-4 w-4 lg:h-3.5 lg:w-3.5 shrink-0 accent-accent" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm lg:text-xs font-medium text-ink truncate">{m.name}</span>
                    <span className="block text-[11px] text-ink-muted truncate">
                      {[m.code, m.departmentName, m.line, !m.isActive ? 'inactive' : m.status !== 'ACTIVE' ? m.status.toLowerCase() : null].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${on ? 'bg-success-bg text-success' : 'bg-subtle text-ink-faint'}`}
                    aria-hidden
                  >
                    {on ? 'On' : 'Off'}
                  </span>
                </label>
              )
            })
          )}
        </div>

        <Field label="Note" hint="Optional · e.g. Extra shift for urgent order">
          <TextInput value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why these machines run" />
        </Field>
      </form>
    </Modal>
  )
}
