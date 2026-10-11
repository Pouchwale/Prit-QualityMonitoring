import React, { useState } from 'react'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
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
  teamAverage: number | null
}

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** Green for 0%, orange down to −20%, red below. */
const tone = (score: number) => (score === 0 ? 'text-success' : score >= -20 ? 'text-exception' : 'text-missed')

const tip = (d: DayScore) =>
  `${d.completed} completed · ${d.exceptions} exception${d.exceptions === 1 ? '' : 's'} · ${d.missed} missed` + (d.pending ? ` · ${d.pending} pending (not counted yet)` : '')

const Cell: React.FC<{ d: DayScore; big?: boolean }> = ({ d, big }) =>
  d.score === null ? (
    <span className="text-ink-faint" title={d.pending ? `${d.pending} pending, not counted yet` : 'No checks'}>—</span>
  ) : (
    <span className="whitespace-nowrap" title={tip(d)}>
      <span className={`font-bold tabular-nums ${big ? 'text-[15px]' : ''} ${tone(d.score)}`}>{d.score}%</span>
      {!big && <span className="ml-1 text-[11px] text-ink-muted tabular-nums">{d.done}/{d.assigned}</span>}
    </span>
  )

/**
 * Day-wise worker scores, Monday to Saturday, with the week score and the team average. Shown to
 * Admins and the Super Admin only (the API refuses everyone else).
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
    <Card>
      <CardHeader
        title="Weekly worker scores"
        subtitle="Each day: checks done ÷ checks whose time is over, shown as the gap from 100%: 0% is every check done, −20% is 80% done. Exceptions count as done; pending checks are not counted yet. Days with no checks show —."
        actions={
          <div className="flex items-center gap-2">
            <IconButton label="Previous week" onClick={() => setWeek(addDaysKey(data?.days[0] ?? week, -7))}>
              <ChevronLeft className="w-4 h-4" />
            </IconButton>
            <span className="text-[13px] font-semibold text-ink whitespace-nowrap tabular-nums">
              {data ? `${formatDateKey(data.days[0])} – ${formatDateKey(data.days[5])}` : '…'}
            </span>
            <IconButton label="Next week" onClick={() => setWeek(addDaysKey(data?.days[0] ?? week, 7))} disabled={thisWeek}>
              <ChevronRight className="w-4 h-4" />
            </IconButton>
            <Button size="sm" variant="outline" onClick={exportExcel} loading={exporting} disabled={!data} icon={<Download className="w-3.5 h-3.5" />}>
              Excel
            </Button>
          </div>
        }
      />
      <DataState loading={loading} error={error} onRetry={reload}>
        {data && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-ink-muted">
                  <th className="text-left px-4 py-2.5">Worker</th>
                  {data.days.map((d, i) => (
                    <th key={d} className={`px-3 py-2.5 text-center ${d === today ? 'bg-accent-soft text-accent' : ''}`}>
                      <div className="font-semibold">{DAY_NAMES[i]}</div>
                      <div className="font-normal normal-case">{formatDateKey(d)}</div>
                    </th>
                  ))}
                  <th className="px-4 py-2.5 text-center">Week</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-ink-muted">
                      No workers yet.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.workerId} className="border-t border-line">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink whitespace-nowrap">{r.name}</div>
                        <div className="text-[11px] text-ink-muted">
                          {r.employeeId}
                          {r.department ? ` · ${r.department}` : ''}
                        </div>
                      </td>
                      {r.days.map((d, i) => (
                        <td key={data.days[i]} className={`px-3 py-3 text-center ${data.days[i] === today ? 'bg-accent-soft/50' : ''}`}>
                          <Cell d={d} />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-center bg-subtle/60">
                        <Cell d={r.week} big />
                        {r.week.score !== null && (
                          <div className="text-[11px] text-ink-muted tabular-nums">
                            {r.week.done}/{r.week.assigned}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong">
                  <td className="px-4 py-3 font-semibold text-ink">Team average</td>
                  <td colSpan={6} />
                  <td className="px-4 py-3 text-center">
                    {data.teamAverage === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <span className={`text-[15px] font-bold tabular-nums ${tone(data.teamAverage)}`}>{data.teamAverage}%</span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </DataState>
    </Card>
  )
}
