import { dateKey } from './dates'

/** The last 7 days (the score screen). */
export const SCORE_DAYS = 6

export const SCORE_RANGE = () => {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - SCORE_DAYS)
  return { from: dateKey(from), to: dateKey(to) }
}

/**
 * Today only: the Today screen's score badge and the Profile "My performance" card both use this,
 * so the two always show the same score.
 */
export const TODAY_RANGE = () => {
  const today = dateKey(new Date())
  return { from: today, to: today }
}
