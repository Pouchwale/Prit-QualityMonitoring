import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { db } from '../db/client'
import { HttpError, badRequest, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { loadDeletePermissions, requireDeletePermission } from '../lib/deletePermissions'
import {
  DELETE_TYPE_PERMISSION,
  MAX_IDS,
  SECOND_CONFIRMATION,
  auditSnapshot,
  deleteImpact,
  deleteInTransaction,
  removeFiles,
  type DeleteType
} from '../services/deletion'

/**
 * Permanent deletion of users, jobs and quality checks (services/deletion.ts).
 *
 *   GET  /api/deletions/permissions        the signed-in user's delete permissions (for the UI)
 *   POST /api/deletions/:type/impact       what would be deleted: { ids }
 *   POST /api/deletions/:type              delete: { ids, reason, impactToken, bulk, confirmation?, confirmLarge? }
 *
 * :type is users, jobs or checks. Each needs its delete permission (DELETE_USERS, DELETE_JOBS,
 * DELETE_CHECKS): the Super Admin always has them, an Admin only Delete Jobs/Checks when a Super
 * Admin granted them, and Managers and Workers never. Deleting users is the Super Admin's alone.
 * Without the permission the API answers 403, whatever the UI shows. An unknown user id is 404.
 */
export const deletionsRouter = Router()

deletionsRouter.get('/permissions', async (req, res) => {
  res.json({ permissions: await loadDeletePermissions(req.user!.id, req.user!.role), thresholds: SECOND_CONFIRMATION, maxIds: MAX_IDS })
})

const TYPES = ['users', 'jobs', 'checks'] as const
const typeOf = (value: unknown): DeleteType => z.enum(TYPES).parse(value)

/** The delete permission for the :type in the path. */
const permissionForType: RequestHandler = (req, res, next) => {
  let type: DeleteType
  try {
    type = typeOf(req.params.type)
  } catch {
    return next(badRequest('Unknown record type'))
  }
  requireDeletePermission(DELETE_TYPE_PERMISSION[type])(req, res, next)
}

const ids = z
  .array(z.string().uuid('Invalid record id'))
  .min(1, 'Select at least one record')
  .max(MAX_IDS, `At most ${MAX_IDS} records can be deleted at once`)

deletionsRouter.post('/:type/impact', permissionForType, async (req, res) => {
  const type = typeOf(req.params.type)
  const body = z.object({ ids }).parse(req.body)
  const impact = await deleteImpact(type, body.ids, req.user!)
  if (type === 'users' && impact.missing.length) throw notFound(impact.missing.length === 1 ? 'User' : `${impact.missing.length} users`)
  res.json(impact)
})

const ACTION: Record<DeleteType, { single: string; bulk: string; entity: string }> = {
  users: { single: 'DELETE_USER', bulk: 'BULK_DELETE_USERS', entity: 'User' },
  jobs: { single: 'DELETE_JOB', bulk: 'BULK_DELETE_JOBS', entity: 'Job' },
  checks: { single: 'DELETE_CHECK', bulk: 'BULK_DELETE_CHECKS', entity: 'QualityCheck' }
}

deletionsRouter.post('/:type', permissionForType, async (req, res) => {
  const type = typeOf(req.params.type)
  const body = z
    .object({
      ids,
      reason: z.string().trim().min(1, 'A reason is required').max(500, 'Keep the reason under 500 characters'),
      impactToken: z.string().min(1, 'Review what will be deleted first'),
      bulk: z.boolean().default(false),
      /** Bulk only: the typed confirmation, "DELETE <count>". */
      confirmation: z.string().optional(),
      /** Bulk above the threshold: the second confirmation. */
      confirmLarge: z.boolean().optional()
    })
    .parse(req.body)

  const unique = [...new Set(body.ids)]
  if (!body.bulk && unique.length !== 1) throw badRequest('Delete one record at a time, or use bulk delete')
  if (body.bulk && body.confirmation?.trim() !== `DELETE ${unique.length}`) {
    throw badRequest(`Type DELETE ${unique.length} to confirm`)
  }

  const actor = req.user!
  const names = ACTION[type]
  const { impact, filePaths } = await db.transaction(async (tx) => {
    // The permission is read again inside the transaction, so a revoke that lands between
    // the check above and now still stops the delete.
    const granted = await loadDeletePermissions(actor.id, actor.role, tx)
    if (!granted[DELETE_TYPE_PERMISSION[type]]) throw new HttpError(403, 'Your delete permission was revoked')

    const result = await deleteInTransaction(tx, type, unique, actor, body.impactToken)
    if (body.bulk && result.impact.needsSecondConfirmation && !body.confirmLarge) {
      throw badRequest(
        `This deletes ${result.impact.totals.records} records and ${result.impact.totals.files} evidence files. Confirm the large deletion.`
      )
    }

    const snapshots = result.impact.items.map(auditSnapshot)
    if (body.bulk) {
      await audit(
        req,
        names.bulk,
        names.entity,
        null,
        { oldValue: { count: snapshots.length, records: snapshots, totals: result.impact.totals }, newValue: { reason: body.reason, deleted: snapshots.length } },
        tx
      )
    } else {
      await audit(req, names.single, names.entity, snapshots[0].id, { oldValue: snapshots[0], newValue: { reason: body.reason } }, tx)
    }
    return result
  })

  // Only now that the database change is committed are the files removed.
  const files = await removeFiles(filePaths)
  res.json({ deleted: impact.items.length, ...files })
})
