import React, { useMemo, useState } from 'react'
import { Coffee, Pencil, Trash2 } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { formatClockRange } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, inputClass } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { TimeInput } from '../../components/common/DateTimeInputs'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { CodeChip, UserAvatar } from '../../components/ui/Chips'

/*
 * Shifts page: each worker's daily break (backend services/workerBreaks.ts). During it the worker gets
 * no check notifications and no check is missed: checks due or ending in it move to the end of the break.
 */

interface WorkerBreakRow {
  workerId: string
  name: string
  employeeId: string
  shiftName: string | null
  startTime: string | null
  endTime: string | null
  durationMinutes: number | null
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const toHHMM = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const lengthOf = (start: string, end: string) => (toMinutes(end) - toMinutes(start) + 1440) % 1440
const durationText = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`)

export const WorkerBreaksCard: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const notify = useToast()
  const { data, error, loading, reload } = useApi<WorkerBreakRow[]>('/api/shifts/breaks')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<WorkerBreakRow | null>(null)
  const [removing, setRemoving] = useState<WorkerBreakRow | null>(null)
  const [form, setForm] = useState({ startTime: '13:00', endTime: '13:30', duration: '30' })
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const rows = useMemo(() => data ?? [], [data])
  const withBreak = rows.filter((r) => r.startTime).length
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.employeeId.toLowerCase().includes(q))
  }, [rows, search])
  const paging = usePagination(filtered, 25, search)

  const openEdit = (r: WorkerBreakRow) => {
    const startTime = r.startTime ?? '13:00'
    const endTime = r.endTime ?? '13:30'
    setForm({ startTime, endTime, duration: String(lengthOf(startTime, endTime)) })
    setFormError(null)
    setEditing(r)
  }

  // Start keeps the duration, End sets the duration, Duration sets the end.
  const setStart = (startTime: string) => {
    const minutes = Number(form.duration)
    setForm({ ...form, startTime, endTime: Number.isInteger(minutes) && minutes > 0 ? toHHMM(toMinutes(startTime) + minutes) : form.endTime })
  }
  const setEnd = (endTime: string) => setForm({ ...form, endTime, duration: String(lengthOf(form.startTime, endTime)) })
  const setDuration = (duration: string) => {
    const minutes = Number(duration)
    setForm({ ...form, duration, endTime: Number.isInteger(minutes) && minutes > 0 ? toHHMM(toMinutes(form.startTime) + minutes) : form.endTime })
  }

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!editing) return
    const minutes = Number(form.duration)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return setFormError('The break must be a whole number of minutes, from 1 to 240.')
    setSaving(true)
    setFormError(null)
    try {
      await api.put(`/api/shifts/breaks/${editing.workerId}`, { startTime: form.startTime, endTime: form.endTime })
      notify('success', 'Break saved', `${editing.name}: ${formatClockRange(form.startTime, form.endTime)}`)
      setEditing(null)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!removing) return
    try {
      await api.del(`/api/shifts/breaks/${removing.workerId}`)
      notify('success', 'Break removed', removing.name)
      reload()
    } catch (err) {
      notify('error', 'Could not remove the break', errorText(err))
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<Coffee className="w-4 h-4" />}
        title="Break times"
        subtitle={`Each worker's daily break${rows.length ? ` · ${withBreak} of ${rows.length} workers have one` : ''}`}
        info="Every day, plant time. During a worker's break they get no check notifications and no check is marked Missed: a check due during the break, or whose time to complete it would end during it, is due at the end of the break instead. Reports count it from then. Other workers are not affected."
      />
      <DataState loading={loading && !data} error={error} onRetry={reload} empty={data ? false : undefined}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} label="Search workers" placeholder="Search name or ID…" className="w-full sm:w-56" />
          <ToolbarSpacer />
          <ResultCount shown={filtered.length} total={rows.length} noun={rows.length === 1 ? 'worker' : 'workers'} />
        </Toolbar>
        {filtered.length === 0 ? (
          <EmptyState icon={<Coffee className="w-5 h-5" />} title={rows.length === 0 ? 'No active workers' : 'No workers match the search'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Shift</th>
                  <th>Break</th>
                  <th>Duration</th>
                  {canEdit && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {paging.visible.map((r) => (
                  <tr key={r.workerId}>
                    <td>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <UserAvatar name={r.name} muted={!r.startTime} />
                        <div className="min-w-0">
                          <div className="font-semibold text-ink truncate">{r.name}</div>
                          <CodeChip>{r.employeeId}</CodeChip>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">{r.shiftName ?? <span className="text-ink-muted">No shift</span>}</td>
                    <td className="whitespace-nowrap tabular-nums">
                      {r.startTime && r.endTime ? formatClockRange(r.startTime, r.endTime) : <span className="text-ink-muted">No break</span>}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{r.durationMinutes ? durationText(r.durationMinutes) : <span className="text-ink-muted">—</span>}</td>
                    {canEdit && (
                      <td className="text-right whitespace-nowrap">
                        <IconButton label={r.startTime ? `Edit ${r.name}'s break` : `Set ${r.name}'s break`} onClick={() => openEdit(r)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </IconButton>
                        {r.startTime && (
                          <IconButton label={`Remove ${r.name}'s break`} tone="danger" onClick={() => setRemoving(r)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </IconButton>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="workers" />
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        maxWidth="lg"
        title={editing?.startTime ? 'Edit break' : 'Set break'}
        subtitle={editing ? `${editing.name} · every day, plant time` : undefined}
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="worker-break-form" loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <form id="worker-break-form" onSubmit={save} noValidate className="space-y-3">
          <FormError message={formError} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Break start" required>
              <TimeInput label="Break start" value={form.startTime} onChange={setStart} />
            </Field>
            <Field label="Break end" required>
              <TimeInput label="Break end" value={form.endTime} onChange={setEnd} />
            </Field>
          </div>
          <Field label="Duration (minutes)" required hint="Changing it moves the end time.">
            <input type="number" min={1} max={240} step={1} value={form.duration} onChange={(e) => setDuration(e.target.value)} className={`${inputClass} sm:max-w-[10rem]`} />
          </Field>
          <p className="text-[11.5px] text-ink-muted">
            During the break this worker gets no check notifications and no check is marked Missed. Checks due then are due at the end of the break.
          </p>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={removing !== null}
        title="Remove break"
        confirmLabel="Remove"
        danger
        message={
          <>
            Remove <span className="font-semibold text-ink">{removing?.name}</span>'s break? Their checks are then due and notified at their normal times again.
          </>
        }
        onConfirm={remove}
        onClose={() => setRemoving(null)}
      />
    </Card>
  )
}
