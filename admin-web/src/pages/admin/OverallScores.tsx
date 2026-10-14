import React from 'react'
import { Award } from 'lucide-react'
import { useApi } from '../../lib/useApi'
import { formatDateKey } from '../../lib/format'
import { DataState } from '../../components/common/DataState'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { ChartLegend, SegmentBar, STATUS_SERIES } from '../../components/ui/charts'

/** GET /api/performance/overall (backend services/performance.ts overallScores). */
interface Score {
  assigned: number
  done: number
  completed: number
  exceptions: number
  missed: number
  pending: number
  score: number | null
}
interface OverallReport {
  asOf: string
  rows: { workerId: string; name: string; employeeId: string; department: string | null; since: string | null; overall: Score }[]
}

/** Green for 0%, amber down to −20%, red below: the same bands as the weekly scores. */
const tone = (score: number) =>
  score === 0
    ? 'bg-success-bg text-success ring-success-line'
    : score >= -20
      ? 'bg-exception-bg text-exception ring-exception-line'
      : 'bg-missed-bg text-missed ring-missed-line'

/**
 * Each worker's overall score: every check from their first one up to today, with the same counts and
 * score as the rest of the page. Shown with Worker Performance view (the API checks the same).
 * Lowest score first, so the workers who need attention lead.
 */
export const OverallScores: React.FC = () => {
  const { data, error, loading, reload } = useApi<OverallReport>('/api/performance/overall')
  const rows = [...(data?.rows ?? [])].sort(
    (a, b) => (a.overall.score ?? 1) - (b.overall.score ?? 1) || a.name.localeCompare(b.name)
  )

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<Award className="w-4 h-4" />}
        title="Overall score since start"
        subtitle={data ? `Each worker's first check up to today, ${formatDateKey(data.asOf)} · lowest score first` : 'Each worker from their first check up to today'}
        info="Every check from the worker's first one up to today, counted together: done (completed + exceptions) ÷ checks whose time is over, minus 100. 0% is every check done. Checks still open are not counted yet. The same formula as the rest of this page."
        actions={<ChartLegend items={STATUS_SERIES} className="hidden lg:flex" />}
      />
      <DataState loading={loading} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState title="No workers yet" compact />
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 p-3">
            {rows.map((r) => {
              const o = r.overall
              const sub = [r.employeeId.toLowerCase() === r.name.toLowerCase() ? null : r.employeeId, r.department].filter(Boolean).join(' · ')
              return (
                <li key={r.workerId} className="rounded-lg border border-line p-3.5 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-ink truncate">{r.name}</div>
                      {sub && <div className="text-[11.5px] text-ink-muted truncate">{sub}</div>}
                      <div className="mt-0.5 text-[11.5px] text-ink-muted">{r.since ? `Since ${formatDateKey(r.since)}` : 'No checks yet'}</div>
                    </div>
                    {o.score === null ? (
                      <span className="shrink-0 rounded-lg bg-subtle px-3 py-2 text-[13px] text-ink-faint">—</span>
                    ) : (
                      <span className={`shrink-0 rounded-lg ring-1 ring-inset px-3 py-1.5 text-center leading-tight ${tone(o.score)}`}>
                        <span className="block text-[20px] font-bold tabular-nums">{o.score}%</span>
                        <span className="block text-[10.5px] tabular-nums opacity-85">
                          {o.done}/{o.assigned} done
                        </span>
                      </span>
                    )}
                  </div>
                  {o.assigned + o.pending > 0 && (
                    <>
                      <SegmentBar values={{ completed: o.completed, exceptions: o.exceptions, missed: o.missed, open: o.pending }} series={STATUS_SERIES} />
                      <dl className="grid grid-cols-4 gap-1 text-center">
                        {[
                          { label: 'Completed', value: o.completed, cls: 'text-success' },
                          { label: 'Exceptions', value: o.exceptions, cls: 'text-exception' },
                          { label: 'Missed', value: o.missed, cls: o.missed ? 'text-missed' : 'text-ink' },
                          { label: 'Open', value: o.pending, cls: 'text-ink-muted' }
                        ].map((f) => (
                          <div key={f.label} className="rounded-md bg-subtle py-1.5 flex flex-col-reverse">
                            <dt className="text-[10.5px] text-ink-muted">{f.label}</dt>
                            <dd className={`text-[15px] font-semibold tabular-nums ${f.cls}`}>{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </DataState>
    </Card>
  )
}
