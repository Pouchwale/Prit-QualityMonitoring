import type { Request } from 'express'
import { db, type Transaction } from '../db/client'
import { auditLogs } from '../db/schema'

export async function audit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | null,
  change: { oldValue?: unknown; newValue?: unknown } = {},
  tx: Transaction | typeof db = db
) {
  await tx.insert(auditLogs).values({
    userId: req.user?.id,
    userName: req.user ? `${req.user.name} (${req.user.employeeId})` : null,
    role: req.user?.role,
    action,
    entity,
    entityId,
    oldValue: change.oldValue ?? null,
    newValue: change.newValue ?? null,
    ipAddress: req.ip
  })
}

/** Removes secrets and noisy timestamps before storing a snapshot in the audit log. */
export function snapshot<T extends Record<string, unknown>>(row: T | undefined) {
  if (!row) return undefined
  const { passwordHash: _p, passwordEncrypted: _e, tokenVersion: _t, createdAt: _c, updatedAt: _u, ...rest } = row as Record<string, unknown>
  return rest
}
