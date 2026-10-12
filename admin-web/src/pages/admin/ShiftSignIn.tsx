import React, { useEffect, useMemo, useState } from 'react'
import { BellRing, LogIn, Save, UserCheck } from 'lucide-react'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { formatDateTime, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle } from '../../components/common/Form'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { Pagination, usePagination } from '../../components/ui/Pagination'
import { CodeChip, Pill, UserAvatar } from '../../components/ui/Chips'

/*
 * Shift-based sign-in for workers (backend services/workerShifts.ts): the reminder settings on the
 * Shifts page and each worker's sign-in status on the Workers page.
 */

export interface ShiftLoginSettings {
  enabled: boolean
  autoLogout: boolean
  reminderIntervalMinutes: number
  maxReminders: number
  earlyLoginMinutes: number
}

export interface WorkerShiftStatus {
  workerId: string
  name: string
  employeeId: string
  shiftName: string | null
  shiftStart: string | null
  shiftEnd: string | null
  onShift: boolean
  /** The plant is closed on the shift's day (e.g. "Weekly Off (Thursday)"): not expected to sign in. */
  dayOff: string | null
  nextShiftStart: string | null
  loggedIn: boolean
  loginAt: string | null
  autoLogoutAt: string | null
  loggedInThisShift: boolean
  remindersSent: number
  lastReminderAt: string | null
  lastLogoutAt: string | null
  lastLogoutReason: 'MANUAL' | 'SHIFT_ENDED' | null
}

// ------------------------------------------------------------------------------- settings (Shifts page)

const LIMITS = {
  reminderIntervalMinutes: [2, 120],
  maxReminders: [1, 10],
  earlyLoginMinutes: [0, 240]
} as const

type NumberKey = keyof typeof LIMITS

/** Shifts page: automatic logout at shift end and the shift-start login reminders. */
export const ShiftLoginSettingsCard: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const notify = useToast()
  const { data, error, loading, reload } = useApi<ShiftLoginSettings>('/api/shifts/login-settings')
  const [form, setForm] = useState<Record<NumberKey, string> & { enabled: boolean; autoLogout: boolean }>({
    enabled: true,
    autoLogout: true,
    reminderIntervalMinutes: '',
    maxReminders: '',
    earlyLoginMinutes: ''
  })
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!data) return
    setForm({
      enabled: data.enabled,
      autoLogout: data.autoLogout,
      reminderIntervalMinutes: String(data.reminderIntervalMinutes),
      maxReminders: String(data.maxReminders),
      earlyLoginMinutes: String(data.earlyLoginMinutes)
    })
  }, [data])

  const dirty =
    !!data &&
    (form.enabled !== data.enabled ||
      form.autoLogout !== data.autoLogout ||
      form.reminderIntervalMinutes !== String(data.reminderIntervalMinutes) ||
      form.maxReminders !== String(data.maxReminders) ||
      form.earlyLoginMinutes !== String(data.earlyLoginMinutes))

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const numbers = {} as Record<NumberKey, number>
    for (const key of Object.keys(LIMITS) as NumberKey[]) {
      const value = Number(form[key])
      const [min, max] = LIMITS[key]
      if (!Number.isInteger(value) || value < min || value > max) {
        return setFormError(`${LABEL[key]} must be a whole number from ${min} to ${max}.`)
      }
      numbers[key] = value
    }
    setSaving(true)
    setFormError(null)
    try {
      await api.put('/api/shifts/login-settings', { enabled: form.enabled, autoLogout: form.autoLogout, ...numbers })
      notify('success', 'Shift sign-in settings saved')
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<BellRing className="w-4 h-4" />}
        title="Shift sign-in"
        subtitle="Automatic logout at shift end and login reminders"
        info="Workers with a shift are signed out of the app when their shift ends, and are reminded (notification and voice) when a shift starts and they have not signed in. Workers without a shift are not affected. Times are plant time."
        actions={
          canEdit && data ? (
            <Button size="sm" variant="primary" type="submit" form="shift-login-form" loading={saving} disabled={!dirty} icon={<Save className="w-3.5 h-3.5" />}>
              Save
            </Button>
          ) : undefined
        }
      />
      <DataState loading={loading} error={error} onRetry={reload} empty={data ? false : undefined}>
        <form id="shift-login-form" onSubmit={save} noValidate className="p-4 space-y-4">
          <FormError message={formError} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle
              checked={form.autoLogout}
              onChange={(v) => setForm((f) => ({ ...f, autoLogout: v }))}
              disabled={!canEdit}
              label="Log workers out at shift end"
              description="Sign-in lasts until the shift ends; outside their shift a worker cannot sign in."
            />
            <Toggle
              checked={form.enabled}
              onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              disabled={!canEdit}
              label="Remind workers to sign in"
              description="Notification and voice alert when a shift starts and the worker has not signed in."
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(LIMITS) as NumberKey[]).map((key) => (
              <Field key={key} label={LABEL[key]} hint={HINT[key]}>
                <TextInput
                  type="number"
                  inputMode="numeric"
                  min={LIMITS[key][0]}
                  max={LIMITS[key][1]}
                  value={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  disabled={!canEdit || (key !== 'earlyLoginMinutes' && !form.enabled) || (key === 'earlyLoginMinutes' && !form.autoLogout)}
                  className="tabular-nums"
                />
              </Field>
            ))}
          </div>
        </form>
      </DataState>
    </Card>
  )
}

const LABEL: Record<NumberKey, string> = {
  reminderIntervalMinutes: 'Repeat every (minutes)',
  maxReminders: 'Reminders per shift',
  earlyLoginMinutes: 'Early sign-in (minutes)'
}

const HINT: Record<NumberKey, string> = {
  reminderIntervalMinutes: '2 to 120. Stops as soon as the worker signs in.',
  maxReminders: '1 to 10, the first one included.',
  earlyLoginMinutes: 'How long before the shift starts a worker may sign in.'
}

// ------------------------------------------------------------------------------- status (Workers page)

type StatusFilter = 'ALL' | 'NOT_SIGNED_IN' | 'SIGNED_IN' | 'OFF_SHIFT'

const REFRESH_MS = 60_000

/** Workers page: who is on shift, who has signed in, and the reminders sent. */
export const ShiftSignInStatusCard: React.FC = () => {
  const { data, error, loading, reload } = useApi<WorkerShiftStatus[]>('/api/users/shift-status')
  const [filter, setFilter] = useState<StatusFilter>('ALL')
  const [search, setSearch] = useState('')

  // The scheduler checks every minute; the card follows.
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS)
    return () => clearInterval(timer)
  }, [reload])

  const rows = useMemo(() => data ?? [], [data])
  const counts = useMemo(
    () => ({
      notSignedIn: rows.filter((r) => r.onShift && !r.loggedIn).length,
      signedIn: rows.filter((r) => r.loggedIn).length,
      offShift: rows.filter((r) => !r.onShift && !r.loggedIn).length
    }),
    [rows]
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows
      .filter((r) =>
        filter === 'NOT_SIGNED_IN' ? r.onShift && !r.loggedIn : filter === 'SIGNED_IN' ? r.loggedIn : filter === 'OFF_SHIFT' ? !r.onShift && !r.loggedIn : true
      )
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.employeeId.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [rows, filter, search])
  const paging = usePagination(filtered, 25, `${filter}|${search}`)

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<UserCheck className="w-4 h-4" />}
        title="Shift sign-in status"
        subtitle="Workers on shift, sign-ins and reminders"
        info="Updated every minute. A worker on shift who has not signed in gets login reminders (Shifts page → Shift sign-in). Sign-ins end automatically at the end of the shift."
        actions={
          counts.notSignedIn > 0 ? (
            <Pill className="bg-exception-bg text-exception ring-exception-line">{counts.notSignedIn} on shift, not signed in</Pill>
          ) : undefined
        }
      />
      <DataState loading={loading && !data} error={error} onRetry={reload} empty={data ? false : undefined}>
        <Toolbar>
          <Segmented<StatusFilter>
            label="Filter by sign-in status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: 'All', count: rows.length },
              { value: 'NOT_SIGNED_IN', label: 'Not signed in', count: counts.notSignedIn },
              { value: 'SIGNED_IN', label: 'Signed in', count: counts.signedIn },
              { value: 'OFF_SHIFT', label: 'Off shift', count: counts.offShift }
            ]}
          />
          <SearchInput value={search} onChange={setSearch} label="Search workers" placeholder="Search name or ID…" className="w-full sm:w-56" />
          <ToolbarSpacer />
          <ResultCount shown={filtered.length} total={rows.length} noun={rows.length === 1 ? 'worker' : 'workers'} />
        </Toolbar>
        {filtered.length === 0 ? (
          <EmptyState icon={<LogIn className="w-5 h-5" />} title={rows.length === 0 ? 'No active workers' : 'No workers match the filter'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table stack-sm">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Shift</th>
                  <th>Status</th>
                  <th>Signed in</th>
                  <th>Auto logout</th>
                  <th>Reminders</th>
                  <th>Last sign-out</th>
                </tr>
              </thead>
              <tbody>
                {paging.visible.map((r) => (
                  <tr key={r.workerId}>
                    <td>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <UserAvatar name={r.name} muted={!r.onShift && !r.loggedIn} />
                        <div className="min-w-0">
                          <div className="font-semibold text-ink truncate">{r.name}</div>
                          <CodeChip>{r.employeeId}</CodeChip>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      {r.shiftName ? (
                        <>
                          <div className="text-ink">{r.shiftName}</div>
                          <div className="text-[11.5px] text-ink-muted tabular-nums">
                            {r.onShift && r.shiftStart && r.shiftEnd
                              ? blockLabel(r.shiftStart, r.shiftEnd)
                              : r.nextShiftStart
                                ? `Next: ${formatDateTime(r.nextShiftStart)}`
                                : '—'}
                          </div>
                        </>
                      ) : (
                        <span className="text-ink-muted">No shift</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <SignInPill row={r} />
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{r.loggedIn ? formatDateTime(r.loginAt) : <span className="text-ink-muted">—</span>}</td>
                    <td className="whitespace-nowrap tabular-nums">{r.autoLogoutAt ? formatDateTime(r.autoLogoutAt) : <span className="text-ink-muted">—</span>}</td>
                    <td className="whitespace-nowrap">
                      {r.remindersSent > 0 ? (
                        <>
                          <div className="text-ink tabular-nums">{r.remindersSent} sent</div>
                          <div className="text-[11.5px] text-ink-muted tabular-nums">Last {formatTime(r.lastReminderAt)}</div>
                        </>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {r.lastLogoutAt ? (
                        <>
                          <div className="text-ink tabular-nums">{formatDateTime(r.lastLogoutAt)}</div>
                          <div className="text-[11.5px] text-ink-muted">{r.lastLogoutReason === 'SHIFT_ENDED' ? 'Shift ended (automatic)' : 'Signed out'}</div>
                        </>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={paging.page} pages={paging.pages} total={paging.total} pageSize={paging.pageSize} onPage={paging.setPage} noun="workers" />
      </DataState>
    </Card>
  )
}

/**
 * "9:00 AM – 6:00 PM"; a stretch of several shifts that runs longer than a day (back-to-back shifts
 * round the clock) shows its dates as well.
 */
const blockLabel = (start: string, end: string) =>
  new Date(end).getTime() - new Date(start).getTime() >= 24 * 3600_000
    ? `${formatDateTime(start)} – ${formatDateTime(end)}`
    : `${formatTime(start)} – ${formatTime(end)}`

/** Workers who need attention first: on shift and not signed in, then signed in, then the rest. */
const rank = (r: WorkerShiftStatus) => (r.onShift && !r.loggedIn ? 0 : r.loggedIn ? 1 : r.shiftName ? 2 : 3)

const SignInPill: React.FC<{ row: WorkerShiftStatus }> = ({ row }) => {
  if (row.loggedIn) return <Pill className="bg-success-bg text-success ring-success-line">Signed in</Pill>
  if (row.onShift) {
    return (
      <Pill className="bg-exception-bg text-exception ring-exception-line" title={row.loggedInThisShift ? 'Signed in earlier in this shift, then signed out' : undefined}>
        {row.loggedInThisShift ? 'Signed out' : 'Not signed in'}
      </Pill>
    )
  }
  if (row.dayOff) return <Pill className="bg-subtle text-ink-secondary ring-line" title="The plant is closed today: no sign-in, checks or reminders">{row.dayOff}</Pill>
  if (!row.shiftName) return <Pill className="bg-subtle text-ink-muted ring-line">No shift</Pill>
  return <Pill className="bg-subtle text-ink-secondary ring-line">Off shift</Pill>
}
