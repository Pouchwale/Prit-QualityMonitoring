import type { Request, RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '../db/client'
import { audit } from './audit'
import { HttpError } from './http'

/**
 * Activating and deactivating records is the Super Admin's alone: user and worker accounts,
 * machines, check types, parameters, schedules, shifts, departments, department mappings and the
 * N/A and exception reasons. It is not part of the permission matrix and cannot be granted, so no
 * role, permission row or crafted request gives it to anyone else. A refused attempt answers 403
 * and is written to the audit log (ACTIVATION_DENIED).
 *
 * Deactivating never deletes: the record and its history stay, and the Super Admin can activate it
 * again.
 */
export const ACTIVATION_DENIED = 'Only the Super Admin can activate or deactivate records'

export const isSuperAdmin = (req: Request) => req.user?.role === 'SUPER_ADMIN'

/** Records the refused attempt and refuses it. */
export async function denyActivation(req: Request, entity: string, id: string | null, detail: Record<string, unknown> = {}): Promise<never> {
  await audit(req, 'ACTIVATION_DENIED', entity, id, { newValue: { method: req.method, path: req.originalUrl, ...detail } }).catch(() => {})
  throw new HttpError(403, ACTIVATION_DENIED)
}

/** Refuses a change of the active state (`from` -> `to`) by anyone but the Super Admin. */
export async function assertActivation(req: Request, entity: string, id: string | null, from: boolean, to: boolean | undefined) {
  if (to === undefined || to === from || isSuperAdmin(req)) return
  await denyActivation(req, entity, id, { from, to })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Guard for a master-data router whose records have an active switch (app.ts). For everyone but the
 * Super Admin:
 *  - creating a record as inactive is refused;
 *  - changing `isActive` of a record (PUT/PATCH /:id..., in any field set) is refused.
 * An edit that leaves `isActive` out keeps the stored value: it is filled in here, so a form or an
 * older app that does not send it can never activate a record by the router's default.
 * Deletes that would deactivate instead are checked where they happen (lib/crud.ts deleteOrDisable).
 */
export function guardActivation(table: PgTable & { id: PgColumn; isActive: PgColumn }, entity: string): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next()
      const parts = req.path.split('/').filter(Boolean)
      const id = parts[0] && UUID.test(parts[0]) ? parts[0] : null
      const body = (req.body ?? {}) as Record<string, unknown>
      const sent = typeof body.isActive === 'boolean' ? body.isActive : undefined

      if (!id) {
        // A new record (POST to the list).
        if (req.method === 'POST' && parts.length === 0 && sent === false && !isSuperAdmin(req)) await denyActivation(req, entity, null, { to: false })
        return next()
      }
      const [row] = (await db
        .select({ isActive: table.isActive })
        .from(table as never)
        .where(eq(table.id, id))) as unknown as { isActive: boolean }[]
      if (!row) return next()
      const current = row.isActive
      if (sent === undefined) {
        // An edit of the record itself without isActive keeps the stored value.
        if (req.method === 'PUT' && parts.length === 1 && req.body && typeof req.body === 'object') body.isActive = current
        return next()
      }
      await assertActivation(req, entity, id, current, sent)
      next()
    } catch (err) {
      next(err)
    }
  }
}
