import React from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'

/** How the score is worked out (backend services/performance.ts), for the info tips of the score pages. */
export const SCORE_INFO =
  'Assigned = checks whose time window has ended (or that are finished); checks still open are shown but not counted. Score = completion − 100, where an exception counts as done: everything done is 0%; 80 of 100 done is −20%. Missed = checks marked Missed.'

/** The score is a percentage, and always carries its sign. */
export const scoreText = (score: number) => `${score}%`

/** Negative scores in red, zero in green: "0%" means every assigned check was done. */
export const ScorePill: React.FC<{ score: number }> = ({ score }) => (
  <span
    className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[11.5px] font-semibold tabular-nums ring-1 ring-inset whitespace-nowrap ${
      score < 0 ? 'bg-missed-bg text-missed ring-missed-line' : 'bg-success-bg text-success ring-success-line'
    }`}
  >
    {score < 0 ? <XCircle className="w-3 h-3" aria-hidden /> : <CheckCircle2 className="w-3 h-3" aria-hidden />}
    {scoreText(score)}
  </span>
)

/** A count cell: coloured when above zero, faint at zero. */
export const Num: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <td className={`num ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)
