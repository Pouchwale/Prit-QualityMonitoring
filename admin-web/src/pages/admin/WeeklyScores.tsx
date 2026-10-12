import React, { useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useApi } from '../../lib/useApi'
import { download, errorText } from '../../lib/api'
import { addDaysKey, dateKey, formatDateKey } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { Card, CardHeader } from '../../components/ui/Card'
import { IconButton } from '../../components/ui/Toolbar'
import { useToast } from '../../components/common/Toast'

/** GET /api/performance/weekly (backend services/performance.ts weeklyScores). */
interface DayScore {
  assigned: number
  done: number
  completed: number
  exceptions: number
  missed: number
  pending: number
  score: number | null
}
interface WeeklyReport {
  weekStart: string
  days: string[]
  rows: { workerId: string; name: string; employeeId: string; department: string | null; days: DayScore[]; week: DayScore }[]
}
type Row = WeeklyReport['rows'][number]

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** The weekday of a YYYY-MM-DD date. */
const dayName = (key: string) => DAY_NAMES[new Date(`${key}T00:00:00Z`).getUTCDay()]
const shortDate = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`

/** Green for 0%, orange down to −20%, red below. */
const tone = (score: number) =>
  score === 0
    ? 'bg-success-bg text-success ring-success-line'
    : score >= -20
      ? 'bg-exception-bg text-exception ring-exception-line'
      : 'bg-missed-bg text-missed ring-missed-line'

const tip = (d: DayScore) =>
  `${d.done} of ${d.assigned} done: ${d.completed} completed, ${d.exceptions} exception${d.exceptions === 1 ? '' : 's'}, ${d.missed} missed` +
  (d.pending ? `; ${d.pending} still open (not counted yet)` : '')

/** "AJAY ZALA" (ID same as the name) or "W-102 · Pouch". */
const subline = (r: Row) => [r.employeeId.toLowerCase() === r.name.toLowerCase() ? null : r.employeeId, r.department].filter(Boolean).join(' · ')

/** One day's (or the week's) score: the score, then done of assigned and any missed checks. */
const Tile: React.FC<{ d: DayScore; upcoming?: boolean; week?: boolean }> = ({ d, upcoming, week }) => {
  if (d.score === null) {
    const label = d.pending ? `${d.pending} open` : '—'
    const title = d.pending ? `${d.pending} check${d.pending === 1 ? '' : 's'} still open, not counted yet` : upcoming ? 'Day still ahead' : 'No checks'
    return (
      <div title={title} className={`h-[54px] rounded-lg flex items-center justify-center text-[12px] ${upcoming ? 'text-ink-faint/60' : 'bg-subtle/60 text-ink-faint'}`}>
        {label}
      </div>
    )
  }
  return (
    <div title={tip(d)} className={`h-[54px] rounded-lg ring-1 ring-inset flex flex-col items-center justify-center leading-tight ${tone(d.score)}`}>
      <span className={`font-bold tabular-nums ${week ? 'text-[18px]' : 'text-[16px]'}`}>{d.score}%</span>
      <span className="text-[11px] tabular-nums whitespace-nowrap opacity-85">
        {d.done}/{d.assigned}
        {d.missed ? <span className="font-semibold"> · {d.missed} missed</span> : null}
      </span>
    </div>
  )
}

/** Phone: a small square per day, with its weekday letter. */
const DayChip: React.FC<{ d: DayScore; date: string; today: string }> = ({ d, date, today }) => (
  <div className="flex flex-col items-center gap-1 min-w-0">
    <span className={`text-[10.5px] font-semibold ${date === today ? 'text-accent' : 'text-ink-muted'}`}>{dayName(date)[0]}</span>
    {d.score === null ? (
      <span title={d.pending ? `${d.pending} check${d.pending === 1 ? '' : 's'} still open` : 'No checks'} className={`w-full h-8 rounded-md flex items-center justify-center text-[11px] ${date > today ? 'text-ink-faint/60' : 'bg-subtle/60 text-ink-faint'}`}>
        {d.pending ? '…' : '—'}
      </span>
    ) : (
      <span title={tip(d)} className={`w-full h-8 rounded-md ring-1 ring-inset flex items-center justify-center text-[11.5px] font-bold tabular-nums ${tone(d.score)} ${date === today ? 'outline outline-2 outline-accent/50' : ''}`}>
        {d.score}
      </span>
    )}
  </div>
)

const LEGEND = [
  { label: '0%: every check done', className: 'bg-success-bg ring-success-line' },
  { label: '0% to −20%', className: 'bg-exception-bg ring-exception-line' },
  { label: 'Below −20%', className: 'bg-missed-bg ring-missed-line' }
]

/**
 * Day-wise worker scores, Sunday to Saturday, with the week score: a coloured tile per worker and day
 * (a card per worker on phones). Shown to Admins and the Super Admin only (the API refuses everyone else).
 */
export const WeeklyScores: React.FC = () => {
  const [week, setWeek] = useState(dateKey())
  const [exporting, setExporting] = useState(false)
  const notify = useToast()
  const { data, error, loading, reload } = useApi<WeeklyReport>('/api/performance/weekly', { week })
  const today = dateKey()
  const thisWeek = data ? today >= data.days[0] && today <= addDaysKey(data.days[0], 6) : false

  const exportExcel = async () => {
    setExporting(true)
    try {
      await download('/api/performance/weekly.xlsx', { week }, `worker-scores-${data?.weekStart ?? week}.xlsx`)
    } catch (err) {
      notify('error', 'Could not download the Excel file', errorText(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<CalendarDays className="w-4 h-4" />}
        title="Worker scores by day"
        subtitle={data ? `${thisWeek ? 'This week · ' : ''}${formatDateKey(data.days[0])} – ${formatDateKey(data.days[data.days.length - 1])}` : 'Sunday to Saturday'}
        info="Each day: checks done ÷ checks whose time is over, shown as the gap from 100%: 0% is every check done, −20% is 80% done. Exceptions count as done; checks still open are not counted yet. Point at a tile for its completed, exception and missed counts."
        actions={
          <div className="flex items-center gap-1.5">
            {!thisWeek && data && (
              <Button size="sm" variant="outline" onClick={() => setWeek(dateKey())}>
                This week
              </Button>
            )}
            <IconButton label="Previous week" onClick={() => setWeek(addDaysKey(data?.days[0] ?? week, -7))}>
              <ChevronLeft className="w-4 h-4" />
            </IconButton>
            <IconButton label="Next week" onClick={() => setWeek(addDaysKey(data?.days[0] ?? week, 7))} disabled={thisWeek}>
              <ChevronRight className="w-4 h-4" />
            </IconButton>
            <Button size="sm" variant="outline" onClick={exportExcel} loading={exporting} disabled={!data} icon={<Download className="w-3.5 h-3.5" />} aria-label="Download Excel">
              <span className="hidden sm:inline">Excel</span>
            </Button>
          </div>
        }
      />
      <DataState loading={loading} error={error} onRetry={reload}>
        {data && data.rows.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-muted">No workers yet.</p>}
        {data && data.rows.length > 0 && (
          <>
            {/* Wide screens: one row per worker, a column per day. */}
            <div className="hidden xl:block overflow-x-auto">
              <table className="w-full min-w-[900px] table-fixed border-separate border-spacing-1.5 px-2.5 py-1.5 text-[13px]">
                <caption className="sr-only">Each worker's score for every day of the week and for the whole week</caption>
                <colgroup>
                  <col className="w-[180px]" />
                  {data.days.map((d) => (
                    <col key={d} />
                  ))}
                  <col className="w-[118px]" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 z-10 bg-white text-left px-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Worker
                    </th>
                    {data.days.map((d) => {
                      const isToday = d === today
                      return (
                        <th
                          key={d}
                          scope="col"
                          className={`rounded-lg px-1 py-1.5 text-center ${isToday ? 'bg-accent text-white' : d > today ? 'text-ink-muted' : 'bg-subtle text-ink'}`}
                        >
                          <div className="text-[12.5px] font-semibold">{dayName(d)}</div>
                          <div className={`text-[11px] font-normal tabular-nums ${isToday ? 'text-white/85' : 'text-ink-muted'}`}>{isToday ? `Today · ${shortDate(d)}` : shortDate(d)}</div>
                        </th>
                      )
                    })}
                    <th scope="col" className="rounded-lg px-1 py-1.5 text-center bg-ink text-white">
                      <div className="text-[12.5px] font-semibold">Week</div>
                      <div className="text-[11px] font-normal text-white/75">Sun – Sat</div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.workerId}>
                      <th scope="row" className="sticky left-0 z-10 bg-white px-1.5 text-left font-normal">
                        <div className="font-semibold text-ink truncate" title={r.name}>
                          {r.name}
                        </div>
                        {subline(r) && <div className="text-[11px] text-ink-muted truncate">{subline(r)}</div>}
                      </th>
                      {r.days.map((d, i) => (
                        // Today's column is tinted all the way down, so it is easy to follow.
                        <td key={data.days[i]} className={data.days[i] === today ? 'rounded-lg bg-accent-soft/60 p-0.5' : ''}>
                          <Tile d={d} upcoming={data.days[i] > today} />
                        </td>
                      ))}
                      <td>
                        <Tile d={r.week} week />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Tablets and phones: a card per worker, the week score and a square per day. */}
            <ul className="xl:hidden grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
              {data.rows.map((r) => (
                <li key={r.workerId} className="rounded-lg border border-line px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-ink truncate">{r.name}</div>
                      {subline(r) && <div className="text-[11.5px] text-ink-muted truncate">{subline(r)}</div>}
                    </div>
                    {r.week.score === null ? (
                      <span className="text-[12px] text-ink-faint shrink-0">{r.week.pending ? `${r.week.pending} open` : 'No checks'}</span>
                    ) : (
                      <span title={tip(r.week)} className={`shrink-0 rounded-lg ring-1 ring-inset px-2.5 py-1 text-right leading-tight ${tone(r.week.score)}`}>
                        <span className="block text-[15px] font-bold tabular-nums">{r.week.score}%</span>
                        <span className="block text-[10.5px] tabular-nums opacity-85">
                          {r.week.done}/{r.week.assigned} this week
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="mt-2.5 grid grid-cols-7 gap-1.5">
                    {r.days.map((d, i) => (
                      <DayChip key={data.days[i]} d={d} date={data.days[i]} today={today} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 border-t border-line text-[11.5px] text-ink-muted">
              {LEGEND.map((l) => (
                <span key={l.label} className="inline-flex items-center gap-1.5">
                  <span className={`w-3 h-3 rounded ring-1 ring-inset ${l.className}`} aria-hidden />
                  {l.label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-subtle" aria-hidden />— no checks
              </span>
            </div>
          </>
        )}
      </DataState>
    </Card>
  )
}
