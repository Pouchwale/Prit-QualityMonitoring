import { Router, type Request } from 'express'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { machineBreakdowns } from '../db/schema'
import { badRequest, forbidden } from '../lib/http'
import { idParam } from '../lib/validate'
import { requireModule } from '../lib/permissions'
import { addDays, parseDateKey } from '../lib/time'
import { assertWorkerInScope, departmentScope, scopedWorkerIds } from '../services/departmentScope'
import {
  breakdownChecks,
  cancelBreakdown,
  currentShiftBlock,
  decideBreakdown,
  getBreakdown,
  listBreakdowns,
  pendingBreakdownCount,
  reportBreakdown
} from '../services/breakdowns'
import { workableMachineIds } from './worker'
import { cleanupTemp, evidenceUpload, filesByField, removeStored, storeEvidence, type StoredEvidence, type UploadedFiles } from '../services/uploads'

/**
 * Machine breakdowns (services/breakdowns.ts).
 *   /api/worker/breakdowns  the worker reports one of their machines broken, sees and withdraws their reports
 *   /api/breakdowns         managers (their department's workers), Admins and the Super Admin decide them
 */

// ---------------------------------------------------------------------------- worker app

export const workerBreakdownRouter = Router()

/** Multipart form (like an exception): the machine, the reason and a photo taken with the camera. */
const reportInput = z.object({
  machineId: z.uuid('Choose the machine that broke down'),
  reason: z.string().trim().min(3, 'Describe the breakdown (at least 3 characters)').max(300),
  photoCapturedAt: z.string().optional()
})

/** The worker's reports of the last 30 days, newest first, and whether they are on shift (can report). */
workerBreakdownRouter.get('/', async (req, res) => {
  const now = new Date()
  const [items, block] = await Promise.all([
    listBreakdowns({ workerIds: null, workerId: req.user!.id, from: addDays(now, -30), limit: 100 }),
    currentShiftBlock(req.user!.id, now)
  ])
  res.json({ items, shift: block ? { name: block.shiftName, start: block.start, end: block.end } : null })
})

workerBreakdownRouter.post('/', evidenceUpload, async (req, res) => {
  const files = req.files as UploadedFiles | undefined
  let stored: StoredEvidence[] = []
  let saved = false
  try {
    const input = reportInput.parse(req.body)
    // Only one of the worker's own machines that is running today.
    if (!(await workableMachineIds(req.user!.id)).includes(input.machineId)) {
      throw forbidden('This machine is not one of your machines.')
    }
    // A photo of the breakdown, taken with the camera, is the proof: required.
    const photo = filesByField(files).get('photo')
    if (!photo) throw badRequest('Please take a photo of the breakdown')
    stored = await storeEvidence([{ file: photo, kind: 'PHOTO', capturedAt: input.photoCapturedAt, label: 'Breakdown photo' }], 'exceptions')
    const [p] = stored
    const breakdown = await reportBreakdown(req, {
      machineId: input.machineId,
      reason: input.reason,
      photo: { path: p.path, mimeType: p.mimeType, sizeBytes: p.sizeBytes, capturedAt: p.capturedAt }
    })
    saved = true
    res.status(201).json(breakdown)
  } catch (err) {
    // Refused (off shift, already reported...): the stored photo is not kept.
    if (!saved) await removeStored(stored)
    throw err
  } finally {
    await cleanupTemp(files)
  }
})

workerBreakdownRouter.post('/:id/cancel', async (req, res) => {
  res.json(await cancelBreakdown(req, idParam(req)))
})

// ---------------------------------------------------------------------------- managers / admins

export const breakdownsRouter = Router()
const view = requireModule('breakdowns', 'view')
const approve = requireModule('breakdowns', 'approve')

/** The workers this user may see: a Manager's department(s); everyone for Admins and the Super Admin. */
const myWorkers = async (req: Request) => scopedWorkerIds(await departmentScope(req.user!))

const listQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  /** Report dates, YYYY-MM-DD (plant time), both included. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
})

breakdownsRouter.get('/pending-count', view, async (req, res) => {
  res.json({ pending: await pendingBreakdownCount(await myWorkers(req)) })
})

breakdownsRouter.get('/', view, async (req, res) => {
  const q = listQuery.parse(req.query)
  res.json(
    await listBreakdowns({
      status: q.status,
      from: q.from ? parseDateKey(q.from) : undefined,
      to: q.to ? addDays(parseDateKey(q.to), 1) : undefined,
      workerIds: await myWorkers(req)
    })
  )
})

/** One report and the worker's checks on that machine in its period (what approving excuses). */
breakdownsRouter.get('/:id', view, async (req, res) => {
  const id = idParam(req)
  const [row] = await db.select().from(machineBreakdowns).where(eq(machineBreakdowns.id, id))
  if (row) await assertWorkerInScope(await departmentScope(req.user!), row.workerId)
  const breakdown = await getBreakdown(id)
  res.json({ breakdown, checks: row ? await breakdownChecks(row) : [] })
})

const decision = z.object({
  approve: z.boolean(),
  /** The manager's reason, kept with the report and on every check it excuses (audit). */
  comment: z.string().trim().min(3, 'Give the reason for your decision (at least 3 characters)').max(500)
})

breakdownsRouter.post('/:id/decision', approve, async (req, res) => {
  const body = decision.parse(req.body)
  res.json(await decideBreakdown(req, await departmentScope(req.user!), idParam(req), body.approve, body.comment))
})
