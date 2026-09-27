import { dateKey } from './dates'

/**
 * The period the worker's own score covers: the last 7 days, the same period the Profile
 * "My performance" card opens on, so the two always agree.
 */
export const SCORE_DAYS = 6

export const SCORE_RANGE = () => {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - SCORE_DAYS)
  return { from: dateKey(from), to: dateKey(to) }
}
