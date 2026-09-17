/**
 * The Result of a scheduled quality check. It tracks only whether the worker did the check
 * after being notified — never whether the readings were good:
 *
 *   Completed  the worker completed the check and submitted the required photo/video and form
 *   Missed     the worker did not complete or submit the check within the required time
 *   Exception  the worker could not do the check and submitted exception details with photo/video
 *   (none)     the check is still pending or due
 *
 * Parameter readings (viscosity, TEAP, …) and their PASS/FAIL against the limits are separate
 * recorded data and never change the Result. A check submitted with a reading outside its
 * limits is Completed; only the reading shows FAIL.
 *
 * The Status shown anywhere (screens, filters, exports, PDF) is the same three values. Checks
 * that are not finished yet have no status to show. PENDING / DUE / IN_PROGRESS exist only
 * internally, to open checks at the right time, send alerts and detect missed checks.
 */

export const CHECK_RESULTS = ['COMPLETED', 'MISSED', 'EXCEPTION'] as const
export type CheckResult = (typeof CHECK_RESULTS)[number]

export const RESULT_LABEL: Record<CheckResult, string> = {
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  EXCEPTION: 'Exception'
}

type Status = 'PENDING' | 'DUE' | 'IN_PROGRESS' | 'COMPLETED' | 'MISSED' | 'EXCEPTION'

export function resultOf(status: Status): CheckResult | null {
  switch (status) {
    case 'COMPLETED':
      return 'COMPLETED'
    case 'MISSED':
      return 'MISSED'
    case 'EXCEPTION':
      return 'EXCEPTION'
    default:
      return null
  }
}

/** Statuses that make up each result, for filtering in the database. */
export const RESULT_STATUSES: Record<CheckResult, Status[]> = {
  COMPLETED: ['COMPLETED'],
  MISSED: ['MISSED'],
  EXCEPTION: ['EXCEPTION']
}
