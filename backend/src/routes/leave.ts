import fs from 'node:fs'
import path from 'node:path'
import { Router, type RequestHandler, type Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { leaveRequests, leaveTypes, shiftChangeRequests } from '../db/schema'
import { config } from '../config'
import { HttpError, badRequest, conflict, notFound } from '../lib/http'
import { audit, snapshot } from '../lib/audit'
import { idParam } from '../lib/validate'
import { can, requireModule } from '../lib/permissions'
import { assertActivation, isSuperAdmin } from '../lib/activation'
import { deleteOrDisable } from '../lib/crud'
import {
  ATTACHMENT_ERROR,
  ATTACHMENT_MAX_BYTES,
  acceptsAttachment,
  applyForLeave,
  attachmentFile,
  cancelRequest,
  checkLeave,
  decideRequest,
  getLeaveSettings,
  leaveCalendar,
  leaveReport,
  listLeaveRequests,
  listShiftChanges,
  pendingCounts,
  requestShiftChange,
  saveLeaveSettings,
  workerLeaveOverview,
  type LeaveSettings
} from '../services/leave'

/** One optional supporting document (PDF or photo), field "attachment". */
const attachmentUpload = multer({
  dest: path.join(config.uploadDir, '.tmp'),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => (acceptsAttachment(file.originalname) ? cb(null, true) : cb(new HttpError(400, ATTACHMENT_ERROR)))
}).single('attachment')

const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, 'Choose a valid date')
const leaveInput = z.object({
  leaveTypeId: z.uuid('Choose a leave type'),
  dayPart: z.enum(['FULL', 'FIRST_HALF', 'SECOND_HALF']).default('FULL'),
  startDate: dateKey,
  endDate: dateKey,
  reason: z.string().trim().min(3, 'Write the reason for the leave').max(1000),
  customType: z.string().trim().max(60, 'Keep the leave name to 60 characters').optional()
})
const shiftInput = z.object({
  requestedShiftId: z.uuid('Choose the shift you want to work'),
  startDate: dateKey,
  endDate: dateKey,
  reason: z.string().trim().min(3, 'Write the reason for the change').max(1000)
})
const kindParam = (v: unknown) => z.enum(['leave', 'shift']).parse(v)

/** Streams a request's attachment (the caller already checked who may see it). */
async function sendAttachment(res: Response, row: { attachmentPath: string | null; attachmentName: string | null; attachmentType: string | null } | undefined) {
  if (!row?.attachmentPath) throw notFound('Attachment')
  const full = attachmentFile(row.attachmentPath)
  if (!full.startsWith(path.resolve(config.uploadDir) + path.sep) || !fs.existsSync(full)) throw notFound('Attachment')
  res.setHeader('Content-Type', row.attachmentType ?? 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${(row.attachmentName ?? 'attachment').replace(/["\r\n]/g, '')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox")
  res.sendFile(full)
}

async function attachmentRow(kind: 'leave' | 'shift', id: string) {
  const table = kind === 'leave' ? leaveRequests : shiftChangeRequests
  const [row] = await db
    .select({ workerId: table.workerId, attachmentPath: table.attachmentPath, attachmentName: table.attachmentName, attachmentType: table.attachmentType })
    .from(table)
    .where(eq(table.id, id))
  return row
}

// ---------------------------------------------------------------------------- Worker app (/api/worker/leave)

/**
 * The worker's own leave: apply, request shift changes, cancel, balances and history. Workers only
 * (app.ts), with the Worker role's "Leave in the app" feature (Roles & Permissions); a worker only
 * ever sees and changes their own requests.
 */
export const workerLeaveRouter = Router()
const workerLeave = requireModule('app_leave', 'create')

workerLeaveRouter.get('/', workerLeave, async (req, res) => {
  res.json(await workerLeaveOverview(req.user!.id))
})

/** The days a leave would count, and whether it passes the rules, before it is sent. */
workerLeaveRouter.post('/preview', workerLeave, async (req, res) => {
  const input = leaveInput.extend({ reason: z.string().optional().default('preview') }).parse(req.body)
  const { days, skipped } = await checkLeave(req.user!.id, input, true)
  res.json({ days, skipped })
})

workerLeaveRouter.post('/requests', workerLeave, attachmentUpload, async (req, res) => {
  const input = leaveInput.parse(req.body)
  res.status(201).json(await applyForLeave(req, req.user!, input, req.file))
})

workerLeaveRouter.post('/requests/:id/cancel', workerLeave, async (req, res) => {
  res.json(await cancelRequest(req, 'leave', idParam(req), true))
})

workerLeaveRouter.post('/shift-changes', workerLeave, attachmentUpload, async (req, res) => {
  const input = shiftInput.parse(req.body)
  res.status(201).json(await requestShiftChange(req, req.user!, input, req.file))
})

workerLeaveRouter.post('/shift-changes/:id/cancel', workerLeave, async (req, res) => {
  res.json(await cancelRequest(req, 'shift', idParam(req), true))
})

workerLeaveRouter.get('/attachment/:kind/:id', workerLeave, async (req, res) => {
  const row = await attachmentRow(kindParam(req.params.kind), idParam(req))
  // Only the worker's own requests.
  if (!row || row.workerId !== req.user!.id) throw notFound('Attachment')
  await sendAttachment(res, row)
})

// ---------------------------------------------------------------------------- Admin panel (/api/leave)

/**
 * Leave Management for staff: requests and shift changes (Leave view), decisions (Leave approve),
 * cancelling (Leave edit), reports and calendar (Leave view), settings and leave types (Leave
 * Settings view / edit; the email recipients the Super Admin only).
 */
export const leaveRouter = Router()
const view = requireModule('leave', 'view')
const approve = requireModule('leave', 'approve')
const cancel = requireModule('leave', 'edit')
const settingsView = requireModule('leave_settings', 'view')
const settingsCreate = requireModule('leave_settings', 'create')
const settingsEdit = requireModule('leave_settings', 'edit')
const settingsDelete = requireModule('leave_settings', 'delete')

const filters = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  from: dateKey.optional(),
  to: dateKey.optional(),
  workerId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  leaveTypeId: z.uuid().optional(),
  decidedById: z.uuid().optional(),
  q: z.string().trim().max(100).optional()
})

/** The Leave Approval badge: requests waiting for a decision (view or approve). */
leaveRouter.get('/pending-count', ((req, res, next) =>
  can(req.user!.actions, 'leave', 'view') || can(req.user!.actions, 'leave', 'approve') ? next() : next(new HttpError(403, 'You do not have permission for this action'))) as RequestHandler, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(await pendingCounts())
})

leaveRouter.get('/requests', view, async (req, res) => {
  res.json(await listLeaveRequests(filters.parse(req.query)))
})

leaveRouter.get('/shift-changes', view, async (req, res) => {
  const { leaveTypeId: _l, ...f } = filters.parse(req.query)
  res.json(await listShiftChanges(f))
})

const decision = z.object({ approve: z.boolean(), comment: z.string().trim().max(1000).optional() })

leaveRouter.post('/requests/:id/decision', approve, async (req, res) => {
  const body = decision.parse(req.body)
  res.json(await decideRequest(req, 'leave', idParam(req), body.approve, body.comment || null))
})

leaveRouter.post('/shift-changes/:id/decision', approve, async (req, res) => {
  const body = decision.parse(req.body)
  res.json(await decideRequest(req, 'shift', idParam(req), body.approve, body.comment || null))
})

leaveRouter.post('/requests/:id/cancel', cancel, async (req, res) => {
  res.json(await cancelRequest(req, 'leave', idParam(req), false))
})

leaveRouter.post('/shift-changes/:id/cancel', cancel, async (req, res) => {
  res.json(await cancelRequest(req, 'shift', idParam(req), false))
})

leaveRouter.get('/attachment/:kind/:id', view, async (req, res) => {
  await sendAttachment(res, await attachmentRow(kindParam(req.params.kind), idParam(req)))
})

/** Approved leave and shift changes (pending ones too), and the plant's closed days, between two dates. */
leaveRouter.get('/calendar', view, async (req, res) => {
  const q = z.object({ from: dateKey, to: dateKey }).parse(req.query)
  if (q.to < q.from) throw badRequest('The end date must be on or after the start date')
  res.json(await leaveCalendar(q.from, q.to, true))
})

/** Every worker's balance per leave type in the leave year of `at` (today when left out). */
leaveRouter.get('/report', view, async (req, res) => {
  const q = z.object({ at: dateKey.optional() }).parse(req.query)
  res.json(await leaveReport(q.at ?? new Date().toISOString().slice(0, 10)))
})

// ---- settings and leave types

leaveRouter.get('/types', ((req, res, next) =>
  can(req.user!.actions, 'leave', 'view') || can(req.user!.actions, 'leave_settings', 'view') ? next() : next(new HttpError(403, 'You do not have permission for this action'))) as RequestHandler, async (_req, res) => {
  res.json(await db.select().from(leaveTypes).orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name)))
})

const typeInput = z.object({
  name: z.string().trim().min(2, 'Name is required').max(60),
  code: z.string().trim().min(1, 'Code is required').max(12).transform((v) => v.toUpperCase()),
  annualQuota: z.number().min(0).max(366).nullable(),
  isPaid: z.boolean(),
  allowHalfDay: z.boolean(),
  // Supporting documents are not used for leave: always off.
  requiresAttachment: z.boolean().optional().transform(() => false),
  maxConsecutiveDays: z.number().min(0.5).max(366).nullable(),
  advanceNoticeDays: z.number().int().min(0).max(365),
  carryForwardMax: z.number().min(0).max(366),
  isCustom: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0)
})

leaveRouter.post('/types', settingsCreate, async (req, res) => {
  const body = typeInput.parse(req.body)
  await assertActivation(req, 'LeaveType', null, true, body.isActive)
  const [row] = await db.insert(leaveTypes).values(body).returning()
  await audit(req, 'CREATE_LEAVE_TYPE', 'LeaveType', row.id, { newValue: snapshot(row) })
  res.status(201).json(row)
})

leaveRouter.put('/types/:id', settingsEdit, async (req, res) => {
  const id = idParam(req)
  const body = typeInput.parse(req.body)
  const [before] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, id))
  if (!before) throw notFound('Leave type')
  // Turning a leave type on or off is activation: the Super Admin's alone.
  await assertActivation(req, 'LeaveType', id, before.isActive, body.isActive)
  const [row] = await db.update(leaveTypes).set({ ...body, updatedAt: new Date() }).where(eq(leaveTypes.id, id)).returning()
  await audit(req, 'UPDATE_LEAVE_TYPE', 'LeaveType', id, { oldValue: snapshot(before), newValue: snapshot(row) })
  res.json(row)
})

/**
 * Deletes a leave type. One that requests still use is kept for their history: the Super Admin's
 * delete switches it off instead; anyone else is told it is in use (switching off is activation).
 */
leaveRouter.delete('/types/:id', settingsDelete, async (req, res) => {
  const id = idParam(req)
  const [before] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, id))
  if (!before) throw notFound('Leave type')
  const result = await deleteOrDisable(
    leaveTypes,
    id,
    async () => (await db.execute(sql`select 1 from leave_requests where leave_type_id = ${id} limit 1`)).rows.length > 0,
    {
      canDisable: isSuperAdmin(req),
      deny: async () => {
        throw conflict(`${before.name} is used by leave requests, so it is kept for their history. Ask the Super Admin to switch it off.`)
      }
    }
  )
  await audit(req, result === 'deleted' ? 'DELETE_LEAVE_TYPE' : 'DISABLE_LEAVE_TYPE', 'LeaveType', id, { oldValue: snapshot(before) })
  res.json({ result })
})

const emailList = z.array(z.string().trim().email('Invalid email address')).max(20)
const settingsInput = z.object({
  leaveYearStartMonth: z.number().int().min(1).max(12),
  countWeeklyOffs: z.boolean(),
  countHolidays: z.boolean(),
  maxPastDays: z.number().int().min(0).max(90),
  maxShiftChangeDays: z.number().int().min(1).max(366),
  workerCanCancelApproved: z.boolean(),
  notify: z.object({
    approvers: z.boolean(),
    worker: z.boolean(),
    approverEmails: emailList,
    superAdminEmail: z.union([z.literal(''), z.string().trim().email('Invalid Super Admin email')]),
    copySuperAdmin: z.boolean(),
    ccEmails: emailList
  })
})

leaveRouter.get('/settings', settingsView, async (_req, res) => {
  res.json(await getLeaveSettings())
})

leaveRouter.put('/settings', settingsEdit, async (req, res) => {
  const next = settingsInput.parse(req.body) as LeaveSettings
  const before = await getLeaveSettings()
  // Who gets the leave emails is the Super Admin's decision; others keep it as it is.
  if (JSON.stringify(next.notify) !== JSON.stringify(before.notify) && !isSuperAdmin(req)) {
    throw new HttpError(403, 'Only the Super Admin can change the leave email recipients')
  }
  await saveLeaveSettings(next)
  await audit(req, 'UPDATE_LEAVE_SETTINGS', 'Settings', 'leaveSettings', { oldValue: before, newValue: next })
  res.json(next)
})

