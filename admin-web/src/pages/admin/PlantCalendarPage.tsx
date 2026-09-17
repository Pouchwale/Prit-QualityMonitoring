import React, { useMemo, useState } from 'react'
import { BellOff, CalendarCheck2, CalendarOff, ChevronLeft, ChevronRight, ClipboardX, Info, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ClosureType, PlantClosure } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { addDaysKey, dateKey } from '../../lib/format'
import { CLOSURE_TYPES } from '../../lib/closureTypes'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { Field, FormError, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { useToast } from '../../components/common/Toast'

const TYPE_ORDER: ClosureType[] = ['CLOSED', 'HOLIDAY', 'SHUTDOWN']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const keyToDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const longDate = (key: string) => keyToDate(key).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const shortDate = (key: string, withYear = true) =>
  keyToDate(key).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })
const monthTitle = (month: Date) => month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
const daysBetween = (from: string, to: string) => Math.round((keyToDate(to).getTime() - keyToDate(from).getTime()) / 86_400_000) + 1

/** The 6-week grid (Monday first) that shows a month. */
function monthGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = addDaysKey(dateKey(first), -((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => addDaysKey(start, i))
}

/** Consecutive days with the same type and reason, shown as one entry in the upcoming list. */
function groupRanges(rows: PlantClosure[]) {
  const ranges: { from: string; to: string; type: ClosureType; reason: string | null; first: PlantClosure }[] = []
  for (const row of rows) {
    const last = ranges[ranges.length - 1]
    if (last && addDaysKey(last.to, 1) === row.date && last.type === row.type && last.reason === row.reason) last.to = row.date
    else ranges.push({ from: row.date, to: row.date, type: row.type, reason: row.reason, first: row })
  }
  return ranges
}

type Editor =
  | { mode: 'new'; from: string; to: string; multiDay: boolean; type: ClosureType; reason: string }
  | { mode: 'edit'; closure: PlantClosure; date: string; type: ClosureType; reason: string }

export const PlantCalendarPage: React.FC = () => {
  const canEdit = useCanManage('calendar')
  const notify = useToast()
  const today = dateKey()

  const [month, setMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selected, setSelected] = useState(today)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<PlantClosure | null>(null)

  const grid = useMemo(() => monthGrid(month), [month])
  const monthData = useApi<PlantClosure[]>('/api/plant-closures', { from: grid[0], to: grid[grid.length - 1] })
  const upcoming = useApi<PlantClosure[]>('/api/plant-closures', { from: today, to: addDaysKey(today, 365) })

  const byDate = useMemo(() => new Map((monthData.data ?? []).map((c) => [c.date, c])), [monthData.data])
  const upcomingRanges = useMemo(() => groupRanges(upcoming.data ?? []), [upcoming.data])
  const monthKey = dateKey(month).slice(0, 7)
  const closedThisMonth = (monthData.data ?? []).filter((c) => c.date.startsWith(monthKey)).length
  const selectedClosure = byDate.get(selected) ?? null

  const reload = () => {
    monthData.reload()
    upcoming.reload()
  }

  const goToMonth = (offset: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + offset, 1))
  const goToDate = (key: string) => {
    const d = keyToDate(key)
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1))
    setSelected(key)
  }

  const openNew = (from = selected) => {
    setFormError(null)
    setEditor({ mode: 'new', from, to: from, multiDay: false, type: 'HOLIDAY', reason: '' })
  }
  const openEdit = (closure: PlantClosure) => {
    setFormError(null)
    setEditor({ mode: 'edit', closure, date: closure.date, type: closure.type, reason: closure.reason ?? '' })
  }

  const selectDay = (key: string) => {
    setSelected(key)
    if (!key.startsWith(monthKey)) goToDate(key)
  }

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!editor) return
    const reason = editor.reason.trim() || null
    const removedText = (n: number) => (n ? ` ${n} open or missed check${n === 1 ? ' was' : 's were'} removed.` : '')
    setFormError(null)

    try {
      setSaving(true)
      if (editor.mode === 'new') {
        const to = editor.multiDay ? editor.to : editor.from
        if (!editor.from || !to) return setFormError('Choose the date')
        if (to < editor.from) return setFormError('End date must be on or after the start date')
        if (daysBetween(editor.from, to) > 366) return setFormError('Mark at most 366 days at a time')
        const result = await api.post<{ dates: string[]; removedChecks: number }>('/api/plant-closures', { from: editor.from, to, type: editor.type, reason })
        const days = result.dates.length
        notify(
          'success',
          `${days === 1 ? shortDate(editor.from) : `${days} days`} marked as ${CLOSURE_TYPES[editor.type].label}`,
          `No checks or alerts on ${days === 1 ? 'this date' : 'these dates'}.${removedText(result.removedChecks)}`
        )
        goToDate(editor.from)
      } else {
        if (!editor.date) return setFormError('Choose the date')
        const result = await api.put<{ removedChecks: number }>(`/api/plant-closures/${editor.closure.id}`, { date: editor.date, type: editor.type, reason })
        notify(
          'success',
          'Closed day updated',
          `${shortDate(editor.date)} · ${CLOSURE_TYPES[editor.type].label}.${editor.date !== editor.closure.date ? ` ${shortDate(editor.closure.date)} is open again.` : ''}${removedText(result.removedChecks)}`
        )
        goToDate(editor.date)
      }
      setEditor(null)
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
      await api.del(`/api/plant-closures/${removing.id}`)
      notify('success', `${shortDate(removing.date)} is open again`, 'Checks for this day are scheduled again from the schedules.')
      setEditor(null)
      reload()
    } catch (err) {
      notify('error', 'Could not remove the closed day', errorText(err))
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Plant Calendar"
        description="Mark days when the plant is closed. No checks are scheduled, no alerts are sent and nothing is marked Missed on these days."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={() => openNew(selected < today ? today : selected)} icon={<Plus className="w-3.5 h-3.5" />}>
              Mark Closed Days
            </Button>
          )
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
        {/* Month */}
        <section className="bg-white border border-line rounded-lg shadow-2xs overflow-hidden" aria-label="Plant calendar">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-3 border-b border-line">
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-ink tracking-tight" aria-live="polite">
                {monthTitle(month)}
              </h2>
              <p className="text-[11px] text-ink-muted">
                {monthData.loading && !monthData.data
                  ? 'Loading…'
                  : closedThisMonth
                    ? `${closedThisMonth} closed day${closedThisMonth === 1 ? '' : 's'} this month`
                    : 'Plant open every day this month'}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => goToDate(today)} disabled={monthKey === today.slice(0, 7) && selected === today}>
                Today
              </Button>
              <div className="flex rounded border border-line shadow-2xs overflow-hidden">
                <button type="button" onClick={() => goToMonth(-1)} aria-label="Previous month" className="h-[36px] w-[40px] lg:h-7 lg:w-8 flex items-center justify-center bg-white text-ink-secondary hover:bg-slate-50 hover:text-ink border-r border-line">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => goToMonth(1)} aria-label="Next month" className="h-[36px] w-[40px] lg:h-7 lg:w-8 flex items-center justify-center bg-white text-ink-secondary hover:bg-slate-50 hover:text-ink">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {monthData.error && (
            <div className="px-4 py-2 text-xs text-failed bg-missed-bg border-b border-missed-line flex items-center justify-between gap-2">
              <span>{monthData.error}</span>
              <Button size="sm" variant="outline" onClick={monthData.reload}>Retry</Button>
            </div>
          )}

          <div className="grid grid-cols-7 border-b border-line bg-slate-50">
            {WEEKDAYS.map((d, i) => (
              <div key={d} className={`py-2 text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider ${i === 6 ? 'text-ink-faint' : 'text-ink-muted'}`}>
                <span className="sm:hidden">{d.slice(0, 1)}</span>
                <span className="hidden sm:inline">{d}</span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7" role="grid">
            {grid.map((key, i) => {
              const closure = byDate.get(key)
              const inMonth = key.startsWith(monthKey)
              const isToday = key === today
              const isSelected = key === selected
              const past = key < today
              const style = closure ? CLOSURE_TYPES[closure.type] : null
              const label = `${longDate(key)}${closure ? `, ${style!.label}${closure.reason ? `: ${closure.reason}` : ''}` : ', plant open'}`
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  aria-label={label}
                  aria-selected={isSelected}
                  onClick={() => selectDay(key)}
                  onDoubleClick={() => canEdit && (closure ? openEdit(closure) : openNew(key))}
                  className={`relative flex flex-col items-stretch text-left min-h-[54px] sm:min-h-[88px] lg:min-h-[100px] p-1 sm:p-2 border-line transition-colors focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                    i % 7 !== 6 ? 'border-r' : ''
                  } ${i < 35 ? 'border-b' : ''} ${style ? style.cell : inMonth ? 'bg-white hover:bg-slate-50' : 'bg-slate-50/70 hover:bg-slate-100/70'}`}
                >
                  {isSelected && <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-accent" aria-hidden />}
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={`inline-flex items-center justify-center h-6 min-w-6 px-1 rounded-full text-[12px] sm:text-[13px] font-semibold tabular-nums ${
                        isToday ? 'bg-accent text-white' : inMonth ? (past && !closure ? 'text-ink-muted' : 'text-ink') : 'text-ink-faint'
                      }`}
                    >
                      {keyToDate(key).getDate()}
                    </span>
                    {style && (
                      <span className={`hidden sm:inline-flex items-center justify-center w-5 h-5 rounded-full ${style.chip} ${inMonth ? '' : 'opacity-60'}`} aria-hidden>
                        {style.icon}
                      </span>
                    )}
                  </span>
                  {style && (
                    <>
                      <span className={`sm:hidden mt-auto mx-auto mb-0.5 h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
                      <span className={`hidden sm:block mt-auto ${inMonth ? '' : 'opacity-60'}`}>
                        <span className="block text-[11px] font-semibold text-ink leading-tight truncate">{style.label}</span>
                        {closure!.reason && <span className="block text-[11px] text-ink-secondary leading-tight line-clamp-2 break-words">{closure!.reason}</span>}
                      </span>
                    </>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 sm:px-4 py-2.5 border-t border-line bg-slate-50/60 text-[11px] text-ink-secondary">
            {TYPE_ORDER.map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-full ${CLOSURE_TYPES[t].dot}`} aria-hidden />
                {CLOSURE_TYPES[t].label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-accent" aria-hidden />
              Today
            </span>
            {canEdit && (
              <span className="text-ink-muted sm:ml-auto">
                <span className="lg:hidden">Tap a day to mark or edit it</span>
                <span className="hidden lg:inline">Select a day to mark or edit it · double-click to open it directly</span>
              </span>
            )}
          </div>
        </section>

        {/* Side panel */}
        <aside className="space-y-4">
          <SelectedDay
            date={selected}
            today={today}
            closure={selectedClosure}
            loading={monthData.loading && !monthData.data}
            canEdit={canEdit}
            onMark={() => openNew(selected)}
            onEdit={() => selectedClosure && openEdit(selectedClosure)}
            onRemove={() => selectedClosure && setRemoving(selectedClosure)}
          />

          <section className="bg-white border border-line rounded-lg shadow-2xs overflow-hidden">
            <div className="px-4 py-2.5 border-b border-line flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink">Upcoming closures</h2>
              <span className="text-[11px] text-ink-muted">next 12 months</span>
            </div>
            {upcoming.error ? (
              <p className="px-4 py-4 text-xs text-failed">{upcoming.error}</p>
            ) : upcomingRanges.length === 0 ? (
              <p className="px-4 py-5 text-xs text-ink-muted text-center">{upcoming.loading ? 'Loading…' : 'No closed days planned.'}</p>
            ) : (
              <ul className="divide-y divide-line max-h-[340px] overflow-y-auto">
                {upcomingRanges.map((r) => {
                  const style = CLOSURE_TYPES[r.type]
                  const days = daysBetween(r.from, r.to)
                  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4)
                  return (
                    <li key={r.from}>
                      <button type="button" onClick={() => goToDate(r.from)} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-start gap-3">
                        <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-full flex items-center justify-center ${style.chip}`} aria-hidden>
                          {style.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-semibold text-ink">
                            {days === 1 ? shortDate(r.from) : `${shortDate(r.from, !sameYear)} – ${shortDate(r.to)}`}
                          </span>
                          <span className="block text-[11px] text-ink-muted truncate">
                            {style.label}
                            {r.reason ? ` · ${r.reason}` : ''}
                            {days > 1 ? ` · ${days} days` : ''}
                          </span>
                        </span>
                        {r.from === today && <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">Today</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="bg-slate-50 border border-line rounded-lg px-4 py-3">
            <h2 className="text-xs font-bold text-ink flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-ink-muted" /> On a closed day
            </h2>
            <ul className="mt-2 space-y-1.5 text-[11px] text-ink-secondary">
              <li className="flex gap-2"><CalendarOff className="w-3.5 h-3.5 shrink-0 text-ink-muted" /> Scheduled checks are skipped</li>
              <li className="flex gap-2"><BellOff className="w-3.5 h-3.5 shrink-0 text-ink-muted" /> Workers get no check alerts</li>
              <li className="flex gap-2"><ClipboardX className="w-3.5 h-3.5 shrink-0 text-ink-muted" /> Nothing is marked Missed</li>
              <li className="flex gap-2"><CalendarCheck2 className="w-3.5 h-3.5 shrink-0 text-ink-muted" /> Completed and Exception records are kept</li>
            </ul>
          </section>
        </aside>
      </div>

      {editor && (
        <ClosureModal
          editor={editor}
          today={today}
          saving={saving}
          error={formError}
          onChange={(next) => setEditor(next)}
          onClose={() => setEditor(null)}
          onSubmit={save}
          onRemove={() => editor.mode === 'edit' && setRemoving(editor.closure)}
        />
      )}

      <ConfirmModal
        isOpen={removing !== null}
        title="Open the plant on this day?"
        message={
          removing && (
            <>
              <span className="font-semibold text-ink">{longDate(removing.date)}</span> will no longer be a closed day. Its quality checks are scheduled again from
              the schedules and workers get alerts as usual.
              {removing.date <= today && ' Checks whose time has already passed will show as Missed.'}
            </>
          )
        }
        confirmLabel="Open the plant"
        danger
        onConfirm={remove}
        onClose={() => setRemoving(null)}
      />
    </div>
  )
}

const SelectedDay: React.FC<{
  date: string
  today: string
  closure: PlantClosure | null
  loading: boolean
  canEdit: boolean
  onMark: () => void
  onEdit: () => void
  onRemove: () => void
}> = ({ date, today, closure, loading, canEdit, onMark, onEdit, onRemove }) => {
  const style = closure ? CLOSURE_TYPES[closure.type] : null
  const when = date === today ? 'Today' : date === addDaysKey(today, 1) ? 'Tomorrow' : date === addDaysKey(today, -1) ? 'Yesterday' : null
  return (
    <section className="bg-white border border-line rounded-lg shadow-2xs overflow-hidden" aria-live="polite">
      <div className="px-4 pt-3 pb-3 border-b border-line">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{when ?? 'Selected day'}</div>
        <div className="mt-0.5 text-sm font-bold text-ink">{longDate(date)}</div>
      </div>
      <div className="px-4 py-3">
        {loading ? (
          <p className="text-xs text-ink-muted">Loading…</p>
        ) : closure && style ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${style.chip}`} aria-hidden>
                {style.icon}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink">{style.label}</div>
                <div className="text-xs text-ink-secondary break-words">{closure.reason || <span className="text-ink-faint">No reason added</span>}</div>
              </div>
            </div>
            <p className="text-[11px] text-ink-muted">No checks are scheduled and no alerts are sent on this day.</p>
            {canEdit && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={onEdit} icon={<Pencil className="w-3.5 h-3.5" />} className="flex-1">
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={onRemove} icon={<Trash2 className="w-3.5 h-3.5" />} className="flex-1 text-failed hover:text-failed">
                  Remove
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="w-2 h-2 rounded-full bg-success" aria-hidden />
              Plant open · checks run as scheduled
            </div>
            {canEdit && (
              <Button size="sm" variant="primary" onClick={onMark} icon={<CalendarOff className="w-3.5 h-3.5" />} className="w-full">
                Mark as closed
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

const ClosureModal: React.FC<{
  editor: Editor
  today: string
  saving: boolean
  error: string | null
  onChange: (editor: Editor) => void
  onClose: () => void
  onSubmit: (e: React.SyntheticEvent) => void
  onRemove: () => void
}> = ({ editor, today, saving, error, onChange, onClose, onSubmit, onRemove }) => {
  const isNew = editor.mode === 'new'
  const from = isNew ? editor.from : editor.date
  const to = isNew && editor.multiDay ? editor.to : from
  const valid = !!from && !!to && to >= from
  const days = valid ? daysBetween(from, to) : 0
  const includesPast = valid && from < today
  const includesToday = valid && from <= today && to >= today

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isNew ? 'Mark plant closed' : 'Edit closed day'}
      subtitle={isNew ? 'Checks and alerts are skipped on these dates' : longDate(editor.closure.date)}
      maxWidth="lg"
      footer={
        <div className="flex w-full flex-col-reverse sm:flex-row sm:items-center gap-2">
          {!isNew && (
            <Button type="button" variant="ghost" onClick={onRemove} icon={<Trash2 className="w-3.5 h-3.5" />} className="text-failed hover:text-failed sm:mr-auto">
              Remove closed day
            </Button>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 sm:flex-none">
              Cancel
            </Button>
            <Button type="submit" form="closure-form" variant="primary" loading={saving} disabled={!valid} className="flex-1 sm:flex-none">
              {isNew ? (days > 1 ? `Mark ${days} days closed` : 'Mark closed') : 'Save changes'}
            </Button>
          </div>
        </div>
      }
    >
      <form id="closure-form" onSubmit={onSubmit} className="space-y-4">
        <FormError message={error} />

        <Field label="Type" required>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Type">
            {TYPE_ORDER.map((t) => {
              const style = CLOSURE_TYPES[t]
              const active = editor.type === t
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onChange({ ...editor, type: t })}
                  className={`flex sm:flex-col items-center sm:items-start gap-2.5 sm:gap-1.5 text-left px-3 py-2.5 rounded-md border transition-colors ${
                    active ? 'border-accent bg-blue-50/60 ring-1 ring-accent' : 'border-line-strong bg-white hover:bg-slate-50'
                  }`}
                >
                  <span className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center ${style.chip}`} aria-hidden>
                    {style.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-ink">{style.label}</span>
                    <span className="block text-[11px] text-ink-muted leading-snug">{style.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </Field>

        {isNew ? (
          <>
            <div className={`grid grid-cols-1 ${editor.multiDay ? 'sm:grid-cols-2' : ''} gap-3`}>
              <Field label={editor.multiDay ? 'From date' : 'Date'} required>
                <TextInput
                  type="date"
                  value={editor.from}
                  onChange={(e) => onChange({ ...editor, from: e.target.value, to: editor.to < e.target.value ? e.target.value : editor.to })}
                  required
                />
              </Field>
              {editor.multiDay && (
                <Field label="To date" required error={editor.to && editor.to < editor.from ? 'Must be on or after the From date' : null}>
                  <TextInput type="date" value={editor.to} min={editor.from} onChange={(e) => onChange({ ...editor, to: e.target.value })} required />
                </Field>
              )}
            </div>
            <Toggle
              checked={editor.multiDay}
              onChange={(multiDay) => onChange({ ...editor, multiDay, to: multiDay && editor.to < editor.from ? editor.from : editor.to })}
              label="Several days in a row"
              description={editor.multiDay && valid ? `${days} day${days === 1 ? '' : 's'} · every date in the range is marked` : 'For a shutdown week or a long holiday'}
            />
          </>
        ) : (
          <Field label="Date" required hint="Moving a closed day opens the plant again on the old date">
            <TextInput type="date" value={editor.date} onChange={(e) => onChange({ ...editor, date: e.target.value })} required />
          </Field>
        )}

        <Field label="Reason" hint="Optional · shown on the calendar and in the worker app">
          <TextInput
            value={editor.reason}
            maxLength={200}
            placeholder={editor.type === 'HOLIDAY' ? 'e.g. Diwali' : editor.type === 'SHUTDOWN' ? 'e.g. Annual maintenance' : 'e.g. Sunday weekly off'}
            onChange={(e) => onChange({ ...editor, reason: e.target.value })}
          />
        </Field>

        {(includesPast || includesToday) && (
          <div className="flex gap-2 px-3 py-2.5 rounded-md border border-exception-line bg-exception-bg text-[11px] text-ink-secondary">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px text-exception" />
            <span>
              {includesToday && 'Today’s open checks are removed and workers get no more alerts today. '}
              {includesPast && 'On past dates, checks that were never submitted — including Missed checks — are removed from monitoring and reports. '}
              Completed and Exception records are kept.
            </span>
          </div>
        )}
      </form>
    </Modal>
  )
}
