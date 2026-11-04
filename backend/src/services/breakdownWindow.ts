import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { machineBreakdowns, qualityChecks } from '../db/schema'

/**
 * A check that falls in a machine breakdown its worker reported (services/breakdowns.ts): same
 * worker, same machine, due from the report until the end of that shift, and the report is still
 * waiting for a decision or was approved. Kept in its own module so notifications.ts can use it
 * without importing the breakdown service (which sends notifications itself).
 */
export const inReportedBreakdown = sql`exists (
  select 1 from ${machineBreakdowns}
  where ${machineBreakdowns.status} in ('PENDING', 'APPROVED')
    and ${machineBreakdowns.workerId} = ${qualityChecks.workerId}
    and ${machineBreakdowns.machineId} = ${qualityChecks.machineId}
    and ${qualityChecks.scheduledAt} >= ${machineBreakdowns.startedAt}
    and ${qualityChecks.scheduledAt} < ${machineBreakdowns.endsAt}
)`

/** "Check due" alerts are paused for these checks from the moment the breakdown is reported. */
export const notInReportedBreakdown = sql`not ${inReportedBreakdown}`

/**
 * Every minute (checkGenerator.refreshStatuses): checks created in an approved breakdown period
 * after the approval (the scheduler makes them one at a time) are excused as they appear, before
 * they could become Due or Missed. Returns how many were excused.
 */
export async function applyApprovedBreakdowns() {
  const rows = await db.execute(sql`
    update ${qualityChecks} as qc
    set status = 'EXCUSED', breakdown_id = mb.id
    from ${machineBreakdowns} as mb
    where mb.status = 'APPROVED'
      and mb.ends_at > now() - interval '1 day'
      and qc.worker_id = mb.worker_id
      and qc.machine_id = mb.machine_id
      and qc.scheduled_at >= mb.started_at
      and qc.scheduled_at < mb.ends_at
      and qc.submitted_at is null
      and qc.status in ('PENDING', 'DUE', 'IN_PROGRESS', 'MISSED')
    returning qc.id`)
  return rows.rowCount ?? rows.rows.length
}
