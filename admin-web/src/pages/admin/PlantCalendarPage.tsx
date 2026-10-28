import React, { useMemo, useState } from 'react'
import {
  BellOff,
  BriefcaseBusiness,
  CalendarCheck2,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ClipboardX,
  FileSpreadsheet,
  Info,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  UserMinus
} from 'lucide-react'
import type { CalendarYearSummary, ClosureType, DayState, LeaveCalendarData, LeaveRequest, MachineDayPlan, PlantClosure, WeeklyRule } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useAuth, useCanManage } from '../../lib/auth'
import { addDaysKey, calendarKey, dateKey, formatDateKey, formatLongDate } from '../../lib/format'
import { CLOSURE_TYPES, WEEKDAY_NAMES, WEEKLY_OFF_STYLE, isClosedType } from '../../lib/closureTypes'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { Field, FormError, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { useToast } from '../../components/common/Toast'
import { AnnualCalendarsTab } from './calendar/AnnualCalendarsTab'
import { MachinesRunningSection } from './calendar/MachineDayPlan'
import { WeeklyRulesTab } from './calendar/WeeklyRulesTab'
import { DateInput } from '../../components/common/DateTimeInputs'
import { Card, CardHeader } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/Toolbar'

/** First date managed by annual calendars; earlier dates keep the original Plant Calendar setup. */
const CALENDAR_V2_START = '2027-01-01'
const LAST_LEGACY_DATE = '2026-12-31'

type Tab = 'calendar' | 'years' | 'rules'
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'calendar', label: 'Calendar', icon: <CalendarDays className="w-3.5 h-3.5" /> },
  { id: 'years', label: 'Annual calendars', icon: <FileSpreadsheet className="w-3.5 h-3.5" /> },
  { id: 'rules', label: 'Weekly rules', icon: <CalendarRange className="w-3.5 h-3.5" /> }
]

export const PlantCalendarPage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('calendar')
  const [yearId, setYearId] = useState<string | null>(null)
  const open = (next: Tab, id: string | null = null) => {
    setTab(next)
    setYearId(id)
  }
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<CalendarDays className="w-4.5 h-4.5" />}
        title="Plant Calendar"
        description="Closed days: no checks, no alerts, nothing marked Missed"
        info="Weekly off days, holidays and closed days: no checks, no alerts and nothing marked Missed. An Adjustment Working Day opens the plant on that date."
        tabs={
          <div role="tablist" aria-label="Plant Calendar" className="scroll-hint flex items-center gap-1 border-b border-line max-w-full overflow-x-auto">
            {TABS.map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => open(t.id)}
                  className={`relative inline-flex items-center gap-1.5 h-10 lg:h-9 px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                    active ? 'text-accent-strong' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  <span aria-hidden className={active ? 'text-accent' : 'text-ink-faint'}>
                    {t.icon}
                  </span>
                  {t.label}
                  {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-accent" aria-hidden />}
                </button>
              )
            })}
          </div>
        }
      />
      {tab === 'calendar' && <CalendarView onOpen={open} />}
      {tab === 'years' && <AnnualCalendarsTab yearId={yearId} onOpenYear={(id) => open('years', id)} />}
      {tab === 'rules' && <WeeklyRulesTab />}
    </div>
  )
}

const TYPE_ORDER: ClosureType[] = ['HOLIDAY', 'SHUTDOWN', 'CLOSED', 'WORKING']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const keyToDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const longDate = (key: string) => formatLongDate(key)
const shortDate = (key: string) => formatDateKey(key)
const monthTitle = (month: Date) => month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
const daysBetween = (from: string, to: string) => Math.round((keyToDate(to).getTime() - keyToDate(from).getTime()) / 86_400_000) + 1

/** The 6-week grid (Monday first) that shows a month. */
function monthGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = addDaysKey(calendarKey(first), -((first.getDay() + 6) % 7))
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

const CalendarView: React.FC<{ onOpen: (tab: Tab, yearId?: string | null) => void }> = ({ onOpen }) => {
  const canEdit = useCanManage('calendar')
  const notify = useToast()
  const today = dateKey()

  // Opens on the plant's current month.
  const [month, setMonth] = useState(() => keyToDate(`${today.slice(0, 8)}01`))
  const [selected, setSelected] = useState(today)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<PlantClosure | null>(null)
  const grid = useMemo(() => monthGrid(month), [month])
  // Open or closed, and why, for every day shown: decided by the backend (entries, weekly off, weekly rules).
  const monthData = useApi<DayState[]>('/api/plant-closures/days', { from: grid[0], to: grid[grid.length - 1] })
  const upcoming = useApi<PlantClosure[]>('/api/plant-closures', { from: today, to: addDaysKey(today, 365) })
  const years = useApi<{ firstYear: number; years: CalendarYearSummary[] }>('/api/calendar-years')
  const rules = useApi<{ rules: WeeklyRule[] }>('/api/weekly-rules')
  const legacy = useApi<{ weeklyOffDays: number[] }>('/api/plant-closures/settings')
  // Machine day plans: which machines run on a date (overrides the plant calendar per machine).
  const machinePlans = useApi<MachineDayPlan[]>('/api/machine-days', { from: grid[0], to: grid[grid.length - 1] })
  const planByDate = useMemo(() => new Map((machinePlans.data ?? []).map((p) => [p.date, p])), [machinePlans.data])

  // Who is on approved leave (Leave Management), for those who may see leave.
  const seesLeave = useAuth().can('leave')
  const leave = useApi<LeaveCalendarData>(seesLeave ? '/api/leave/calendar' : null, { from: grid[0], to: grid[grid.length - 1] })
  const leaveByDate = useMemo(() => {
    const map = new Map<string, LeaveRequest[]>()
    for (const l of leave.data?.leave ?? []) {
      if (l.status !== 'APPROVED') continue
      for (let d = l.startDate; d <= l.endDate; d = addDaysKey(d, 1)) map.set(d, [...(map.get(d) ?? []), l])
    }
    return map
  }, [leave.data])

  const stateByDate = useMemo(() => new Map((monthData.data ?? []).map((s) => [s.date, s])), [monthData.data])
  const byDate = useMemo(
    () =>
      new Map(
        (monthData.data ?? [])
          .filter((s) => s.entry)
          .map((s) => [s.date, { id: s.entry!.id, date: s.date, type: s.entry!.type, reason: s.entry!.reason, updatedAt: '' } as PlantClosure])
      ),
    [monthData.data]
  )
  const isWeeklyOff = (key: string) => stateByDate.get(key)?.weeklyClosed ?? false
  const yearOf = (key: string) => (years.data?.years ?? []).find((y) => y.year === Number(key.slice(0, 4))) ?? null
  const managedByYear = (key: string) => key >= CALENDAR_V2_START
  const upcomingRanges = useMemo(() => groupRanges(upcoming.data ?? []), [upcoming.data])
  const monthKey = calendarKey(month).slice(0, 7)
  const monthStates = (monthData.data ?? []).filter((s) => s.date.startsWith(monthKey))
  const closedThisMonth = monthStates.filter((s) => s.closed).length
  const workingThisMonth = monthStates.filter((s) => s.entry?.type === 'WORKING').length
  const viewedYear = Number(monthKey.slice(0, 4))
  const viewedCalendar = viewedYear >= Number(CALENDAR_V2_START.slice(0, 4)) ? yearOf(monthKey) : null
  const selectedClosure = byDate.get(selected) ?? null

  const reload = () => {
    monthData.reload()
    upcoming.reload()
    machinePlans.reload()
  }

  const goToMonth = (offset: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + offset, 1))
  const goToDate = (key: string) => {
    const d = keyToDate(key)
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1))
    setSelected(key)
  }

  const openNew = (from = selected) => {
    if (managedByYear(from)) return onOpen('years', yearOf(from)?.id ?? null)
    setFormError(null)
    // On a weekly off the usual change is to open the plant for that day.
    setEditor({ mode: 'new', from, to: from, multiDay: false, type: isWeeklyOff(from) ? 'WORKING' : 'HOLIDAY', reason: '' })
  }
  const openEdit = (closure: PlantClosure) => {
    if (managedByYear(closure.date)) return onOpen('years', yearOf(closure.date)?.id ?? null)
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
          isClosedType(editor.type)
            ? `No checks or alerts on ${days === 1 ? 'this date' : 'these dates'}.${removedText(result.removedChecks)}`
            : 'The plant runs normally: checks and alerts as scheduled.'
        )
        goToDate(editor.from)
      } else {
        if (!editor.date) return setFormError('Choose the date')
        const result = await api.put<{ removedChecks: number }>(`/api/plant-closures/${editor.closure.id}`, { date: editor.date, type: editor.type, reason })
        notify(
          'success',
          'Calendar date updated',
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
      const nowClosed = isWeeklyOff(removing.date)
      notify(
        'success',
        `${shortDate(removing.date)} removed from the calendar`,
        nowClosed
          ? `${WEEKDAY_NAMES[keyToDate(removing.date).getDay()]} is a weekly off, so the plant is closed on this date: no checks or alerts.`
          : 'The plant is open on this date: checks and alerts as scheduled.'
      )
      setEditor(null)
      reload()
    } catch (err) {
      notify('error', 'Could not remove the closed day', errorText(err))
    }
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted mr-auto">
            <Info className="w-3.5 h-3.5 shrink-0 text-ink-faint" aria-hidden />
            Dates up to 31/12/2026 are edited here. From 2027, dates come from the approved annual calendar.
          </span>
          <Button size="sm" variant="outline" onClick={() => onOpen('years')} icon={<FileSpreadsheet className="w-3.5 h-3.5" />}>
            Annual calendars
          </Button>
          {today <= LAST_LEGACY_DATE && (
            <Button size="sm" variant="primary" onClick={() => openNew(selected < today || managedByYear(selected) ? today : selected)} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Dates
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
        {/* Month */}
        <Card className="overflow-hidden" aria-label="Plant calendar">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-3 border-b border-line">
            <div className="min-w-0">
              <h2 className="text-[16px] sm:text-[17px] font-semibold text-ink tracking-tight" aria-live="polite">
                {monthTitle(month)}
              </h2>
              <p className="text-[12px] text-ink-muted">
                {monthData.loading && !monthData.data
                  ? 'Loading…'
                  : closedThisMonth || workingThisMonth
                    ? [
                        closedThisMonth ? `${closedThisMonth} closed day${closedThisMonth === 1 ? '' : 's'}` : null,
                        workingThisMonth ? `${workingThisMonth} adjustment working day${workingThisMonth === 1 ? '' : 's'}` : null
                      ]
                        .filter(Boolean)
                        .join(' · ') + ' this month'
                    : 'Plant open every day this month'}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => goToDate(today)} disabled={monthKey === today.slice(0, 7) && selected === today}>
                Today
              </Button>
              <div className="flex items-center rounded-md border border-line-strong bg-white shadow-[0_1px_1px_rgb(15_23_42/0.04)]">
                <IconButton label="Previous month" onClick={() => goToMonth(-1)} className="rounded-r-none">
                  <ChevronLeft className="w-4 h-4" />
                </IconButton>
                <span className="w-px self-stretch bg-line" aria-hidden />
                <IconButton label="Next month" onClick={() => goToMonth(1)} className="rounded-l-none">
                  <ChevronRight className="w-4 h-4" />
                </IconButton>
              </div>
            </div>
          </div>

          {viewedYear >= Number(CALENDAR_V2_START.slice(0, 4)) && years.data && (!viewedCalendar || viewedCalendar.status !== 'APPROVED' || viewedCalendar.pendingChanges) && (
            <div className="px-4 py-2 text-[12px] border-b border-exception-line bg-exception-bg flex flex-wrap items-center justify-between gap-2" role="status">
              <span className="inline-flex items-start gap-1.5 text-ink-secondary">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px text-exception" aria-hidden />
                {!viewedCalendar
                  ? `No ${viewedYear} company calendar yet: only the weekly rules apply. Holidays and adjustment working days take effect once the ${viewedYear} calendar is approved.`
                  : viewedCalendar.status !== 'APPROVED'
                    ? `The ${viewedYear} calendar is a draft: its holidays are not in use until it is approved.`
                    : `The ${viewedYear} calendar has changes awaiting approval. The dates shown are the approved ones.`}
              </span>
              <Button size="sm" variant="outline" onClick={() => onOpen('years', viewedCalendar?.id ?? null)}>
                {viewedCalendar ? `Review ${viewedYear}` : 'Annual calendars'}
              </Button>
            </div>
          )}

          {monthData.error && (
            <div className="px-4 py-2 text-[12px] text-missed bg-missed-bg border-b border-missed-line flex items-center justify-between gap-2" role="alert">
              <span>{monthData.error}</span>
              <Button size="sm" variant="outline" onClick={monthData.reload}>Retry</Button>
            </div>
          )}

          <div className="grid grid-cols-7 border-b border-line bg-subtle/60">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
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
              const weeklyOff = !closure && isWeeklyOff(key)
              const style = closure ? CLOSURE_TYPES[closure.type] : weeklyOff ? WEEKLY_OFF_STYLE : null
              const plan = planByDate.get(key)
              const away = leaveByDate.get(key) ?? []
              const label = `${longDate(key)}${
                closure ? `, ${CLOSURE_TYPES[closure.type].label}${closure.reason ? `: ${closure.reason}` : ''}` : weeklyOff ? ', Weekly Off' : ', plant open'
              }${plan ? ', machine plan' : ''}${away.length ? `, ${away.length} on leave` : ''}`
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  aria-label={label}
                  aria-selected={isSelected}
                  onClick={() => selectDay(key)}
                  onDoubleClick={() => canEdit && (closure ? openEdit(closure) : openNew(key))}
                  className={`relative flex flex-col items-stretch text-left min-h-[54px] sm:min-h-[88px] lg:min-h-[96px] p-1 sm:p-1.5 border-line transition-colors focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                    i % 7 !== 6 ? 'border-r' : ''
                  } ${i < 35 ? 'border-b' : ''} ${style ? style.cell : inMonth ? 'bg-white hover:bg-subtle/60' : 'bg-subtle/50 hover:bg-subtle'}`}
                >
                  {isSelected && <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-accent bg-accent/[0.03]" aria-hidden />}
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={`inline-flex items-center justify-center h-6 min-w-6 px-1 rounded-full text-[12px] sm:text-[12.5px] font-semibold tabular-nums ${
                        isToday
                          ? 'bg-accent text-white ring-2 ring-accent-line ring-offset-1'
                          : inMonth
                            ? past && !closure
                              ? 'text-ink-muted'
                              : 'text-ink'
                            : 'text-ink-faint'
                      }`}
                    >
                      {keyToDate(key).getDate()}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      {away.length > 0 && (
                        <span
                          className={`inline-flex items-center justify-center gap-0.5 h-4 sm:h-5 min-w-4 sm:min-w-5 px-0.5 sm:px-1 rounded ring-1 ring-inset ring-due-line bg-due-bg text-due text-[9px] sm:text-[11px] font-semibold leading-none tabular-nums ${inMonth ? '' : 'opacity-60'}`}
                          title={`On leave: ${away.map((l) => l.workerName).join(', ')}`}
                          aria-hidden
                        >
                          <UserMinus className="hidden sm:block w-3 h-3" />
                          {away.length}
                        </span>
                      )}
                      {plan && (
                        <span
                          className={`inline-flex items-center justify-center h-4 sm:h-5 min-w-4 sm:min-w-5 px-0.5 sm:px-1 rounded ring-1 ring-inset ring-accent-line bg-accent-soft text-accent-strong text-[9px] sm:text-[11px] font-semibold leading-none tabular-nums ${inMonth ? '' : 'opacity-60'}`}
                          title={`Machine plan: ${plan.machineIds.length} machine${plan.machineIds.length === 1 ? '' : 's'} running`}
                          aria-hidden
                        >
                          M<span className="hidden sm:inline">·{plan.machineIds.length}</span>
                        </span>
                      )}
                    </span>
                  </span>
                  {away.length > 0 && (
                    <span className={`hidden lg:block mt-1 px-0.5 text-[11px] leading-tight text-due truncate ${inMonth ? '' : 'opacity-60'}`} aria-hidden>
                      {away.slice(0, 2).map((l) => l.workerName).join(', ')}
                      {away.length > 2 ? ` +${away.length - 2}` : ''}
                    </span>
                  )}
                  {style && (
                    <>
                      <span className={`sm:hidden mt-auto mx-auto mb-0.5 h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
                      <span className={`hidden sm:flex flex-col gap-0.5 mt-auto min-w-0 ${inMonth ? '' : 'opacity-60'}`} aria-hidden>
                        <span className={`inline-flex items-center gap-1 self-start max-w-full min-h-5 px-1.5 py-px rounded-md text-[11px] font-semibold leading-tight ${style.chip}`}>
                          <span className="shrink-0 [&>svg]:w-3 [&>svg]:h-3">{style.icon}</span>
                          <span className="line-clamp-2 break-words">{style.short}</span>
                        </span>
                        {closure?.reason && <span className="block px-0.5 text-[11px] text-ink-secondary leading-tight line-clamp-2 break-words">{closure.reason}</span>}
                      </span>
                    </>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 sm:px-4 py-2.5 border-t border-line text-[12px] text-ink-secondary">
            {TYPE_ORDER.map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className={`w-4 h-4 rounded flex items-center justify-center [&>svg]:w-2.5 [&>svg]:h-2.5 ${CLOSURE_TYPES[t].chip}`} aria-hidden>
                  {CLOSURE_TYPES[t].icon}
                </span>
                {CLOSURE_TYPES[t].label}
              </span>
            ))}
            {(monthData.data ?? []).some((s) => s.source === 'WEEKLY') && (
              <span className="inline-flex items-center gap-1.5">
                <span className={`w-4 h-4 rounded flex items-center justify-center [&>svg]:w-2.5 [&>svg]:h-2.5 ${WEEKLY_OFF_STYLE.chip}`} aria-hidden>
                  {WEEKLY_OFF_STYLE.icon}
                </span>
                Weekly Off
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-accent ring-2 ring-accent-line" aria-hidden />
              Today
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center h-4 px-1 rounded ring-1 ring-inset ring-accent-line bg-accent-soft text-accent-strong text-[9px] font-semibold leading-none" aria-hidden>
                M
              </span>
              Machine plan
            </span>
            {seesLeave && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-flex items-center justify-center h-4 px-1 rounded ring-1 ring-inset ring-due-line bg-due-bg text-due" aria-hidden>
                  <UserMinus className="w-2.5 h-2.5" />
                </span>
                On leave
              </span>
            )}
            {canEdit && (
              <span className="text-[11.5px] text-ink-muted sm:ml-auto">
                <span className="lg:hidden">Tap a day to mark or edit it</span>
                <span className="hidden lg:inline">Select a day to mark or edit it · double-click to open it directly</span>
              </span>
            )}
          </div>
        </Card>

        {/* Side panel */}
        <aside className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-4 items-start">
          <SelectedDay
            date={selected}
            today={today}
            closure={selectedClosure}
            weeklyOff={isWeeklyOff(selected)}
            managedYear={managedByYear(selected) ? Number(selected.slice(0, 4)) : null}
            yearStatus={managedByYear(selected) ? yearOf(selected) : null}
            onOpenYear={() => onOpen('years', yearOf(selected)?.id ?? null)}
            loading={monthData.loading && !monthData.data}
            canEdit={canEdit}
            onMark={() => openNew(selected)}
            onEdit={() => selectedClosure && openEdit(selectedClosure)}
            onRemove={() => selectedClosure && setRemoving(selectedClosure)}
          >
            <MachinesRunningSection
              date={selected}
              today={today}
              plantClosed={stateByDate.get(selected)?.closed ?? false}
              plan={planByDate.get(selected) ?? null}
              loading={(machinePlans.loading && !machinePlans.data) || (monthData.loading && !monthData.data)}
              canEdit={canEdit}
              onChanged={machinePlans.reload}
            />
            {machinePlans.error && (
              <p className="mt-2 text-[11.5px] text-missed" role="alert">
                {machinePlans.error}
              </p>
            )}
          </SelectedDay>

          {seesLeave && <OnLeaveCard date={selected} leave={leaveByDate.get(selected) ?? []} loading={leave.loading && !leave.data} error={leave.error} />}

          <WeeklySummaryCard legacyDays={legacy.data?.weeklyOffDays ?? null} rules={rules.data?.rules ?? null} today={today} onOpenRules={() => onOpen('rules')} />

          <Card className="overflow-hidden">
            <CardHeader icon={<CalendarCheck2 className="w-4 h-4" />} title="Upcoming dates" subtitle="Next 12 months" />
            {upcoming.error ? (
              <p className="px-4 py-4 text-[12px] text-missed" role="alert">
                {upcoming.error}
              </p>
            ) : upcomingRanges.length === 0 ? (
              <p className="px-4 py-5 text-[12px] text-ink-muted text-center">{upcoming.loading ? 'Loading…' : 'No holidays or working days planned.'}</p>
            ) : (
              <ul className="divide-y divide-line max-h-[340px] overflow-y-auto">
                {upcomingRanges.map((r) => {
                  const style = CLOSURE_TYPES[r.type]
                  const days = daysBetween(r.from, r.to)
                  return (
                    <li key={r.from}>
                      <button type="button" onClick={() => goToDate(r.from)} className="w-full text-left px-4 py-2.5 hover:bg-subtle/70 flex items-start gap-3">
                        <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-lg flex items-center justify-center ${style.chip}`} aria-hidden>
                          {style.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-semibold text-ink tabular-nums">
                            {days === 1 ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`}
                          </span>
                          <span className="block text-[11.5px] text-ink-muted truncate">
                            {style.label}
                            {r.reason ? ` · ${r.reason}` : ''}
                            {days > 1 ? ` · ${days} days` : ''}
                          </span>
                        </span>
                        {r.from === today && (
                          <span className="inline-flex items-center h-5 px-1.5 rounded-full bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent-line text-[11px] font-semibold">Today</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card padded className="bg-subtle/40 shadow-none">
            <h2 className="text-[12.5px] font-semibold text-ink flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden /> On a closed day (weekly off, holiday, shutdown)
            </h2>
            <ul className="mt-2 space-y-1.5 text-[12px] text-ink-secondary">
              <li className="flex gap-2"><CalendarOff className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden /> Scheduled checks are skipped</li>
              <li className="flex gap-2"><BellOff className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden /> Workers get no check alerts</li>
              <li className="flex gap-2"><ClipboardX className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden /> Nothing is marked Missed</li>
              <li className="flex gap-2"><CalendarCheck2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" aria-hidden /> Completed and Exception records are kept</li>
            </ul>
            <p className="mt-2.5 pt-2.5 border-t border-line text-[12px] text-ink-secondary">
              <span className="font-semibold text-due">Adjustment working days</span> are normal working days: checks are scheduled, workers get alerts
              and Missed checks count as usual.
            </p>
          </Card>
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
        title={
          removing && !isClosedType(removing.type)
            ? 'Remove this adjustment working day?'
            : removing && isWeeklyOff(removing.date)
              ? 'Remove this calendar date?'
              : 'Open the plant on this day?'
        }
        message={
          removing && isWeeklyOff(removing.date) ? (
            <>
              <span className="font-semibold text-ink">{longDate(removing.date)}</span> is a weekly off, so without this entry the plant is{' '}
              <span className="font-semibold text-ink">closed</span> on this date: its checks are removed and workers get no alerts.
            </>
          ) : removing && !isClosedType(removing.type) ? (
            <>
              <span className="font-semibold text-ink">{longDate(removing.date)}</span> is removed from the calendar. The plant keeps running normally on this date.
            </>
          ) : removing && (
            <>
              <span className="font-semibold text-ink">{longDate(removing.date)}</span> will no longer be a closed day. Its quality checks are scheduled again from
              the schedules and workers get alerts as usual.
              {removing.date <= today && ' Checks whose time has already passed will show as Missed.'}
            </>
          )
        }
        confirmLabel={removing && (!isClosedType(removing.type) || isWeeklyOff(removing.date)) ? 'Remove' : 'Open the plant'}
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
  weeklyOff: boolean
  /** 2027+: the date belongs to an annual calendar and is changed there. */
  managedYear: number | null
  yearStatus: CalendarYearSummary | null
  onOpenYear: () => void
  loading: boolean
  canEdit: boolean
  onMark: () => void
  onEdit: () => void
  onRemove: () => void
  /** Extra content under the day's status (the "Machines running" section). */
  children?: React.ReactNode
}> = ({ date, today, closure, weeklyOff, managedYear, yearStatus, onOpenYear, loading, canEdit, onMark, onEdit, onRemove, children }) => {
  const weekday = WEEKDAY_NAMES[keyToDate(date).getDay()]
  const style = closure ? CLOSURE_TYPES[closure.type] : null
  const when = date === today ? 'Today' : date === addDaysKey(today, 1) ? 'Tomorrow' : date === addDaysKey(today, -1) ? 'Yesterday' : null
  return (
    <Card className="overflow-hidden" aria-live="polite">
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-line">
        <span
          className={`w-10 h-10 shrink-0 rounded-lg flex flex-col items-center justify-center leading-none ring-1 ring-inset ${
            date === today ? 'bg-accent text-white ring-accent' : 'bg-subtle text-ink ring-line'
          }`}
          aria-hidden
        >
          <span className={`text-[10px] font-semibold uppercase ${date === today ? 'text-white/85' : 'text-ink-muted'}`}>{weekday.slice(0, 3)}</span>
          <span className="text-[15px] font-semibold tabular-nums">{keyToDate(date).getDate()}</span>
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{when ?? 'Selected day'}</div>
          <div className="mt-0.5 text-[13.5px] font-semibold text-ink">{longDate(date)}</div>
        </div>
      </div>
      <div className="px-4 py-3">
        {loading ? (
          <p className="text-[12px] text-ink-muted">Loading…</p>
        ) : closure && style ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4 ${style.chip}`} aria-hidden>
                {style.icon}
              </span>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-ink">{style.label}</div>
                {(closure.reason || isClosedType(closure.type)) && (
                  <div className="text-[12px] text-ink-secondary break-words">{closure.reason || <span className="text-ink-muted">No reason added</span>}</div>
                )}
              </div>
            </div>
            <p className="text-[11.5px] text-ink-muted">
              {isClosedType(closure.type)
                ? 'No checks are scheduled and no alerts are sent on this day.'
                : weeklyOff
                  ? `Opens the plant on this ${weekday}, normally a weekly off: checks are scheduled and workers get alerts.`
                  : 'The plant runs normally: checks are scheduled and workers get alerts.'}
            </p>
            {managedYear ? (
              <YearLink year={managedYear} status={yearStatus} onOpen={onOpenYear} />
            ) : canEdit && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={onEdit} icon={<Pencil className="w-3.5 h-3.5" />} className="flex-1">
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={onRemove} icon={<Trash2 className="w-3.5 h-3.5" />} className="flex-1 !text-missed hover:!bg-missed-bg">
                  Remove
                </Button>
              </div>
            )}
          </div>
        ) : weeklyOff ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4 ${WEEKLY_OFF_STYLE.chip}`} aria-hidden>
                {WEEKLY_OFF_STYLE.icon}
              </span>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-ink">Weekly Off · Plant closed</div>
                <div className="text-[12px] text-ink-secondary">Every {weekday} is closed unless marked as an Adjustment Working Day.</div>
              </div>
            </div>
            <p className="text-[11.5px] text-ink-muted">No checks are scheduled and no alerts are sent on this day.</p>
            {managedYear ? (
              <YearLink year={managedYear} status={yearStatus} onOpen={onOpenYear} />
            ) : canEdit && (
              <Button size="sm" variant="primary" onClick={onMark} icon={<BriefcaseBusiness className="w-3.5 h-3.5" />} className="w-full">
                Mark as Adjustment Working Day
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full bg-success-bg text-success ring-1 ring-inset ring-success-line text-[12px] font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-chart-completed)]" aria-hidden />
              Plant open · checks run as scheduled
            </div>
            {managedYear ? (
              <YearLink year={managedYear} status={yearStatus} onOpen={onOpenYear} />
            ) : canEdit && (
              <Button size="sm" variant="primary" onClick={onMark} icon={<CalendarOff className="w-3.5 h-3.5" />} className="w-full">
                Add to calendar
              </Button>
            )}
          </div>
        )}
        {children}
      </div>
    </Card>
  )
}

/** 2027+ dates are changed in their annual calendar, after review and approval. */
const YearLink: React.FC<{ year: number; status: CalendarYearSummary | null; onOpen: () => void }> = ({ year, status, onOpen }) => (
  <div className="space-y-2">
    <p className="text-[11.5px] text-ink-muted">
      {status
        ? status.status === 'APPROVED'
          ? `From the approved ${year} calendar. Change it there and approve again.`
          : `The ${year} calendar is still a draft; its dates apply after approval.`
        : `No ${year} calendar yet: only the weekly rules apply to this date.`}
    </p>
    <Button size="sm" variant="outline" onClick={onOpen} icon={<FileSpreadsheet className="w-3.5 h-3.5" />} className="w-full">
      {status ? `Open ${year} calendar` : 'Annual calendars'}
    </Button>
  </div>
)

/** Weekly closures: the locked 2026 weekly off and the weekly rules from 2027. */
const WeeklySummaryCard: React.FC<{ legacyDays: number[] | null; rules: WeeklyRule[] | null; today: string; onOpenRules: () => void }> = ({
  legacyDays,
  rules,
  today,
  onOpenRules
}) => {
  const current = (rules ?? []).filter((r) => !r.effectiveTo || r.effectiveTo >= (today > CALENDAR_V2_START ? today : CALENDAR_V2_START))
  return (
    <Card className="overflow-hidden">
      <CardHeader icon={<CalendarRange className="w-4 h-4" />} title="Weekly off" />
      <div className="px-4 py-3 space-y-2.5 text-[12.5px]">
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Up to 2026</span>
          <span className="text-right font-medium text-ink">
            {legacyDays === null ? '…' : legacyDays.length ? legacyDays.map((d) => WEEKDAY_NAMES[d]).join(', ') : 'None'}
            <span className="block text-[11.5px] font-normal text-ink-muted">Locked</span>
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">From 2027</span>
          <span className="text-right font-medium text-ink">
            {rules === null
              ? '…'
              : current.length
                ? current.map((r) => `${WEEKDAY_NAMES[r.weekday]}${r.effectiveTo ? ` until ${formatDateKey(r.effectiveTo)}` : ''}`).join(', ')
                : 'None'}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={onOpenRules} icon={<CalendarRange className="w-3.5 h-3.5" />} className="w-full">
          Weekly rules
        </Button>
      </div>
    </Card>
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
  const closing = isClosedType(editor.type)
  const includesPast = closing && valid && from < today
  const includesToday = closing && valid && from <= today && to >= today

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isNew ? 'Add to plant calendar' : 'Edit calendar date'}
      subtitle={isNew ? 'Holidays and closed days skip checks and alerts; working days run as normal' : longDate(editor.closure.date)}
      maxWidth="lg"
      footer={
        <div className="flex w-full flex-col-reverse sm:flex-row sm:items-center gap-2">
          {!isNew && (
            <Button type="button" variant="ghost" onClick={onRemove} icon={<Trash2 className="w-3.5 h-3.5" />} className="!text-missed hover:!bg-missed-bg sm:mr-auto">
              Remove from calendar
            </Button>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 sm:flex-none">
              Cancel
            </Button>
            <Button type="submit" form="closure-form" variant="primary" loading={saving} disabled={!valid} className="flex-1 sm:flex-none">
              {isNew
                ? closing
                  ? days > 1 ? `Mark ${days} days closed` : 'Mark closed'
                  : days > 1 ? `Mark ${days} working days` : 'Mark working day'
                : 'Save changes'}
            </Button>
          </div>
        </div>
      }
    >
      <form id="closure-form" onSubmit={onSubmit} className="space-y-4">
        <FormError message={error} />

        {/* A fieldset, not a <label>: a label would give its name to the first option. */}
        <fieldset>
          <legend className="block text-[13px] lg:text-[12.5px] font-medium text-ink-secondary mb-1.5">
            Type<span className="text-missed"> *</span>
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Type">
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
                    active ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line-strong bg-white hover:bg-subtle'
                  }`}
                >
                  <span className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center ${style.chip}`} aria-hidden>
                    {style.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-semibold text-ink">{style.label}</span>
                    <span className="block text-[11px] text-ink-muted leading-snug">{style.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </fieldset>

        {isNew ? (
          <>
            <div className={`grid grid-cols-1 ${editor.multiDay ? 'sm:grid-cols-2' : ''} gap-3`}>
              <Field label={editor.multiDay ? 'From date' : 'Date'} required>
                <DateInput
                  value={editor.from}
                  max={LAST_LEGACY_DATE}
                  onChange={(e) => onChange({ ...editor, from: e.target.value, to: editor.to < e.target.value ? e.target.value : editor.to })}
                  required
                />
              </Field>
              {editor.multiDay && (
                <Field label="To date" required error={editor.to && editor.to < editor.from ? 'Must be on or after the From date' : null}>
                  <DateInput value={editor.to} min={editor.from} max={LAST_LEGACY_DATE} onChange={(e) => onChange({ ...editor, to: e.target.value })} required />
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
          <Field label="Date" required hint="Moving a date clears the old date from the calendar">
            <DateInput value={editor.date} max={LAST_LEGACY_DATE} onChange={(e) => onChange({ ...editor, date: e.target.value })} required />
          </Field>
        )}

        <Field label="Reason" hint="Optional · shown on the calendar and in the worker app">
          <TextInput
            value={editor.reason}
            maxLength={200}
            placeholder={
              editor.type === 'HOLIDAY'
                ? 'e.g. Diwali'
                : editor.type === 'SHUTDOWN'
                  ? 'e.g. Annual maintenance'
                  : editor.type === 'WORKING'
                    ? 'e.g. Adjustment working day'
                    : 'e.g. Sunday weekly off'
            }
            onChange={(e) => onChange({ ...editor, reason: e.target.value })}
          />
        </Field>

        {(includesPast || includesToday) && (
          <div className="flex gap-2 px-3 py-2.5 rounded-md border border-exception-line bg-exception-bg text-[12px] text-ink-secondary" role="note">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px text-exception" aria-hidden />
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

const HALF: Record<LeaveRequest['dayPart'], string> = { FULL: '', FIRST_HALF: ' · First half', SECOND_HALF: ' · Second half' }

/** Who is on approved leave on the selected date (from Leave Management; display only). */
const OnLeaveCard: React.FC<{ date: string; leave: LeaveRequest[]; loading: boolean; error: string | null }> = ({ date, leave, loading, error }) => (
  <Card className="overflow-hidden">
    <CardHeader icon={<UserMinus className="w-4 h-4" />} title="On leave" subtitle={longDate(date)} />
    {error ? (
      <p className="px-4 py-4 text-[12px] text-missed" role="alert">
        {error}
      </p>
    ) : leave.length === 0 ? (
      <p className="px-4 py-5 text-[12px] text-ink-muted text-center">{loading ? 'Loading…' : 'Nobody is on leave.'}</p>
    ) : (
      <ul className="divide-y divide-line max-h-[300px] overflow-y-auto">
        {leave.map((l) => (
          <li key={l.id} className="px-4 py-2.5">
            <span className="block text-[12.5px] font-semibold text-ink">
              {l.workerName} <span className="font-normal text-ink-muted">({l.workerEmployeeId})</span>
            </span>
            <span className="block text-[11.5px] text-ink-muted">
              {l.leaveTypeName}
              {HALF[l.dayPart]}
              {l.departmentName ? ` · ${l.departmentName}` : ''}
              {l.startDate !== l.endDate ? ` · ${formatDateKey(l.startDate)} – ${formatDateKey(l.endDate)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    )}
  </Card>
)
