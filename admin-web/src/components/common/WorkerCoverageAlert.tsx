import React from 'react'
import { UserX } from 'lucide-react'
import type { WorkerGap } from '../../types'

/**
 * Schedules whose machine has no worker on that shift. They create no checks until the admin
 * assigns a worker (backend services/workerAssignment.ts), so the gap is shown, never hidden.
 */
export const WorkerCoverageAlert: React.FC<{ gaps: WorkerGap[]; action?: React.ReactNode }> = ({ gaps, action }) => {
  if (gaps.length === 0) return null
  // One line per machine and shift, even when several check types are scheduled there.
  const lines = [...new Map(gaps.map((g) => [`${g.machineName}|${g.shiftName}`, g])).values()]
  return (
    <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-failed-line bg-failed-bg text-xs" role="alert">
      <UserX className="w-4 h-4 text-failed shrink-0 mt-px" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-failed">
          {lines.length === 1 ? 'Shift with no worker: its checks are not scheduled' : `${lines.length} shifts with no worker: their checks are not scheduled`}
        </div>
        <ul className="mt-1 space-y-0.5 text-ink-secondary">
          {lines.map((g) => (
            <li key={`${g.machineName}|${g.shiftName}`}>
              <span className="font-medium text-ink">{g.machineName}</span> · {g.shiftName} — assign a worker on {g.shiftName} to {g.machineName} in Machine
              Assignment.
            </li>
          ))}
        </ul>
      </div>
      {action}
    </div>
  )
}
