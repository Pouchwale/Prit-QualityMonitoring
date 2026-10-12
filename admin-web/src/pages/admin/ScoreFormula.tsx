import React from 'react'
import { Calculator } from 'lucide-react'
import { Card, CardHeader } from '../../components/ui/Card'

/*
 * How the Worker Performance score is worked out, shown on the page. It mirrors the backend exactly
 * (services/performance.ts: rate() and scoreOf()); change both together.
 *
 *   Score    = round(Done ÷ Assigned × 100) − 100
 *   Done     = Completed + Exceptions
 *   Assigned = Completed + Exceptions + Missed (checks whose time window has ended)
 */

interface Totals {
  assigned: number
  completed: number
  exceptions: number
  missed: number
  open: number
}

/** A term of the formula, in its status colour (with its name in text, never colour alone). */
const Term: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-semibold ring-1 ring-inset ${tone}`}>{children}</span>
)

const DONE = 'bg-success-bg text-success ring-success-line'
const EXC = 'bg-exception-bg text-exception ring-exception-line'
const MISS = 'bg-missed-bg text-missed ring-missed-line'
const NEUTRAL = 'bg-subtle text-ink ring-line'

const WEIGHTS = [
  { factor: 'Completed', dot: 'var(--color-chart-completed)', counts: 'Done', weight: '100%', note: 'Full credit' },
  { factor: 'Exception', dot: 'var(--color-chart-exception)', counts: 'Done', weight: '100%', note: 'Full credit: the worker reported why' },
  { factor: 'Missed', dot: 'var(--color-chart-missed)', counts: 'Not done', weight: '0%', note: 'No credit: lowers the score' },
  { factor: 'Open', dot: 'var(--color-chart-open)', counts: 'Not counted yet', weight: '—', note: 'Counted once its time window ends' }
]

const BANDS = [
  { label: '0%', text: 'every check done', className: 'bg-success-bg ring-success-line' },
  { label: '0% to −20%', text: 'at least 80% done', className: 'bg-exception-bg ring-exception-line' },
  { label: 'Below −20%', text: 'less than 80% done', className: 'bg-missed-bg ring-missed-line' }
]

export const ScoreFormulaCard: React.FC<{ totals?: Totals; period: string }> = ({ totals, period }) => {
  const done = totals ? totals.completed + totals.exceptions : 0
  const completion = totals && totals.assigned ? Math.round((done / totals.assigned) * 100) : null
  const score = completion === null ? null : completion - 100

  return (
    <Card>
      <CardHeader
        icon={<Calculator className="w-4 h-4" />}
        title="How the score is calculated"
        subtitle="The same formula for every worker, the total, the weekly scores, reports and emails"
      />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-6 gap-y-5 p-4">
        {/* 1. The formula */}
        <div className="lg:col-span-5 space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Formula</h3>
          <div className="rounded-lg border border-line bg-panel px-4 py-3.5 space-y-2.5 text-[13px] text-ink-secondary">
            <p className="flex flex-wrap items-center gap-1.5 text-[14px] text-ink">
              <span className="font-semibold">Score</span> =
              <span>(</span>
              <Term tone={DONE}>Done</Term>÷<Term tone={NEUTRAL}>Assigned</Term>× 100
              <span>)</span>− 100
            </p>
            <p className="flex flex-wrap items-center gap-1.5">
              <Term tone={DONE}>Done</Term>= <Term tone={DONE}>Completed</Term>+ <Term tone={EXC}>Exceptions</Term>
            </p>
            <p className="flex flex-wrap items-center gap-1.5">
              <Term tone={NEUTRAL}>Assigned</Term>= <Term tone={DONE}>Completed</Term>+ <Term tone={EXC}>Exceptions</Term>+ <Term tone={MISS}>Missed</Term>
            </p>
          </div>
          <ul className="space-y-1 text-[12px] text-ink-muted list-disc pl-4">
            <li>The completion percentage is rounded to a whole number, then 100 is taken off: 0% is the best score.</li>
            <li>A check counts once its time window has ended; checks still open are left out until then.</li>
            <li>A worker with no counted checks scores 0%. Checks moved by a worker's break are not missed.</li>
          </ul>
        </div>

        {/* 2. What each kind of check is worth */}
        <div className="lg:col-span-4 space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Factors and weightage</h3>
          <table className="w-full text-[12.5px]">
            <caption className="sr-only">How much each kind of check counts towards the score</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-muted border-b border-line">
                <th scope="col" className="py-1.5 font-semibold">Check</th>
                <th scope="col" className="py-1.5 font-semibold">Counts as</th>
                <th scope="col" className="py-1.5 font-semibold text-right">Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {WEIGHTS.map((w) => (
                <tr key={w.factor}>
                  <th scope="row" className="py-2 pr-2 text-left font-medium text-ink">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: w.dot }} aria-hidden />
                      {w.factor}
                    </span>
                    <span className="block pl-[18px] text-[11.5px] font-normal text-ink-muted">{w.note}</span>
                  </th>
                  <td className="py-2 pr-2 align-top text-ink-secondary">{w.counts}</td>
                  <td className="py-2 align-top text-right font-semibold tabular-nums text-ink">{w.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 3. Worked example with this period's numbers, and what the colours mean */}
        <div className="lg:col-span-3 space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">This period</h3>
          {totals && completion !== null && score !== null && totals.assigned > 0 ? (
            <div className="rounded-lg border border-line px-3.5 py-3 text-[12.5px] text-ink-secondary space-y-1.5 tabular-nums">
              <div>
                Done = {totals.completed} + {totals.exceptions} = <span className="font-semibold text-ink">{done}</span>
              </div>
              <div>
                Assigned = {totals.completed} + {totals.exceptions} + {totals.missed} = <span className="font-semibold text-ink">{totals.assigned}</span>
              </div>
              <div>
                {done} ÷ {totals.assigned} × 100 = <span className="font-semibold text-ink">{completion}%</span>
              </div>
              <div className="pt-1.5 border-t border-line text-[13px]">
                Score = {completion} − 100 ={' '}
                <span className={`font-bold ${score === 0 ? 'text-success' : score >= -20 ? 'text-exception' : 'text-missed'}`}>{score}%</span>
              </div>
              <div className="text-[11px] text-ink-muted">
                All shown workers together · {period}
                {totals.open ? ` · ${totals.open} open, not counted yet` : ''}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-ink-muted">No counted checks in this period yet.</p>
          )}
          <ul className="space-y-1.5 text-[12px] text-ink-secondary">
            {BANDS.map((b) => (
              <li key={b.label} className="flex items-center gap-2">
                <span className={`w-3 h-3 rounded ring-1 ring-inset shrink-0 ${b.className}`} aria-hidden />
                <span className="font-semibold text-ink tabular-nums">{b.label}</span>
                <span className="text-ink-muted">{b.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}
