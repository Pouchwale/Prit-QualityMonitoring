/**
 * Leave Management end to end (npm run test:leave): applying, rules, balances, approvals,
 * cancelling, shift changes, the effect on checks, emails (to a fake mail server on 127.0.0.1:2527,
 * so no real email is sent), reminders, permissions and audit. Refuses to run unless DATABASE_URL
 * names a database ending in "_test".
 *
 *   1. Copy the live database into pouchwale_quality_test; start a server on it:
 *      DATABASE_URL=.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 REPORT_OUTBOX_DIR=<tmp> UPLOAD_DIR=<tmp> npm start
 *   2. DATABASE_URL=.../pouchwale_quality_test REPORT_OUTBOX_DIR=<same> UPLOAD_DIR=<same> npm run test:leave
 *   3. Drop the copy.
 */
import net from 'node:net'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { auditLogs, leaveTypes, qualityChecks, reportEmailLogs, rolePermissions, schedules, shiftChangeRequests, shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { dateKey, addDays, parseDateKey, startOfDay } from '../src/lib/time'
import { updateReportSharingSettings } from '../src/services/automatedReports'
import { occurrences, planChecks } from '../src/services/checkGenerator'
import { dayStates } from '../src/services/plantCalendar'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`

let passed = 0
let failed = 0
const results: string[] = []
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// ---------------------------------------------------------------------------- fake mail server
const received: { to: string[]; data: string }[] = []
const server = net.createServer((sock) => {
  sock.write('220 fake\r\n')
  let buf = ''
  let inData = false
  let cur = { to: [] as string[], data: '' }
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1')
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (inData) {
        if (line === '.') {
          inData = false
          received.push(cur)
          cur = { to: [], data: '' }
          sock.write('250 OK\r\n')
        } else cur.data += line + '\n'
        continue
      }
      const cmd = line.slice(0, 4).toUpperCase()
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250-AUTH PLAIN\r\n250 OK\r\n')
      else if (cmd === 'AUTH') sock.write('235 OK\r\n')
      else if (cmd === 'RCPT') {
        cur.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
        sock.write('250 OK\r\n')
      } else if (cmd === 'DATA') {
        inData = true
        sock.write('354 go\r\n')
      } else if (cmd === 'QUIT') {
        sock.write('221 bye\r\n')
        sock.end()
      } else sock.write('250 OK\r\n')
    }
  })
  sock.on('error', () => {})
})
await new Promise<void>((r) => server.listen(2527, '127.0.0.1', () => r()))
/** The message as readable text: encoded subjects and quoted-printable or base64 parts decoded. */
function decodeMail(raw: string) {
  const bytes = (latin: string) => Buffer.from(latin, 'latin1').toString('utf8')
  let s = raw.replace(/(\?=)\s+(=\?)/g, '$1$2')
  s = s.replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_m, enc: string, txt: string) =>
    enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8') : bytes(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))))
  )
  const b64 = [...s.matchAll(/Content-Transfer-Encoding: base64\n(?:[^\n]+\n)*\n([A-Za-z0-9+/=\n]+)/gi)].map((m) => Buffer.from(m[1].replace(/\n/g, ''), 'base64').toString('utf8'))
  const qp = bytes(s.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))))
  return [qp, ...b64].join('\n')
}
const mailTo = (email: string, subject?: RegExp) => received.filter((m) => m.to.includes(email) && (!subject || subject.test(/^Subject: (.*)$/m.exec(decodeMail(m.data))?.[1] ?? '')))
const mailText = (m: { data: string }) => decodeMail(m.data)
const settle = () => new Promise((r) => setTimeout(r, 1500))

// ---------------------------------------------------------------------------- helpers
async function tokenFor(id: string, app: 'web' | 'mobile' = 'web') {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, app).accessToken
}
async function call(token: string, method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}
async function form(token: string, p: string, fields: Record<string, string>, file?: { name: string; type: string; bytes: Buffer }) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  if (file) f.append('attachment', new Blob([file.bytes], { type: file.type }), file.name)
  const res = await fetch(BASE + p, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: f })
  return { status: res.status, json: await res.json().catch(() => null) }
}
/** Every check slot of a schedule in [start, end): planned from just before `end`, so the earlier slots come back as Missed. */
async function slotsIn(scheduleId: string, start: Date, end: Date) {
  const list = await planChecks(new Date(end.getTime() - 60_000), { ignoreOpen: true })
  return list
    .filter((p) => p.scheduleId === scheduleId && (p.scheduledAt as Date) >= start && (p.scheduledAt as Date) < end)
    .sort((x, y) => (x.scheduledAt as Date).getTime() - (y.scheduledAt as Date).getTime())
}
const today = dateKey(new Date())
const plus = (n: number) => dateKey(addDays(parseDateKey(today), n))

// ---------------------------------------------------------------------------- setup
await updateReportSharingSettings({ smtpHost: '127.0.0.1', smtpPort: 2527, smtpSecure: false, smtpUser: 'test', smtpPass: 'test', smtpFrom: 'Quality <qa@ok.test>' })
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [mgr] = await db.select().from(users).where(eq(users.role, 'MANAGER'))
const [w] = await db.select().from(users).where(eq(users.name, 'AJAY THAKOR'))
const [w2] = await db.select().from(users).where(eq(users.name, 'Hiren'))
await db.update(users).set({ email: 'worker@ok.test' }).where(eq(users.id, w.id))
const SA = await tokenFor(sa.id)
const MGR = await tokenFor(mgr.id)
const W = await tokenFor(w.id, 'mobile')
const W2 = await tokenFor(w2.id, 'mobile')
const created = await call(SA, 'POST', '/users', { employeeId: `TLA${Date.now() % 100000}`, name: 'Leave admin', role: 'ADMIN', password: 'secret12' })
const ADMIN = await tokenFor(created.json.id)

const types = Object.fromEntries((await db.select().from(leaveTypes)).map((t) => [t.code, t]))
const typeBody = (t: typeof leaveTypes.$inferSelect, change: Record<string, unknown>) => ({
  name: t.name,
  code: t.code,
  annualQuota: t.annualQuota,
  isPaid: t.isPaid,
  allowHalfDay: t.allowHalfDay,
  requiresAttachment: t.requiresAttachment,
  maxConsecutiveDays: t.maxConsecutiveDays,
  advanceNoticeDays: t.advanceNoticeDays,
  carryForwardMax: t.carryForwardMax,
  isActive: t.isActive,
  sortOrder: t.sortOrder,
  ...change
})

// ---- 1. Migration and settings
{
  check('1a migrations: leave types CL, SL, EL with a quota of 0; Paid Leave (PL) removed', ['CL', 'SL', 'EL'].every((c) => types[c]?.annualQuota === 0) && !types.PL, Object.keys(types).join(','))
  const perms = await db.select().from(rolePermissions).where(inArray(rolePermissions.module, ['leave', 'leave_settings', 'app_leave']))
  check('1b permissions seeded: Admin leave + settings, Manager view + approve, Worker apply', perms.length === 4 && perms.some((p) => p.role === 'MANAGER' && p.module === 'leave' && p.canApprove && !p.canEdit) && perms.some((p) => p.role === 'ADMIN' && p.module === 'leave_settings' && p.canCreate && p.canEdit && p.canDelete) && perms.some((p) => p.role === 'ADMIN' && p.module === 'leave' && p.canApprove))

  const s = (await call(SA, 'GET', '/leave/settings')).json
  const put = await call(SA, 'PUT', '/leave/settings', {
    ...s,
    notify: { ...s.notify, approverEmails: ['hr@ok.test'], superAdminEmail: 'sa@ok.test', copySuperAdmin: true, ccEmails: ['cc@ok.test'] }
  })
  const adminNotify = await call(ADMIN, 'PUT', '/leave/settings', { ...put.json, notify: { ...put.json.notify, ccEmails: ['x@ok.test'] } })
  const adminRule = await call(ADMIN, 'PUT', '/leave/settings', { ...put.json, maxPastDays: 5 })
  const mgrSettings = await call(MGR, 'PUT', '/leave/settings', put.json)
  check('1c Super Admin sets the email recipients; an Admin may change the rules but not the recipients (403); a Manager nothing (403)', put.status === 200 && adminNotify.status === 403 && adminRule.status === 200 && mgrSettings.status === 403, `${put.status},${adminNotify.status},${adminRule.status},${mgrSettings.status}`)
  await call(SA, 'PUT', '/leave/settings', { ...put.json, maxPastDays: 7 })

  // Quotas and rules for the tests.
  const q1 = await call(ADMIN, 'PUT', `/leave/types/${types.CL.id}`, typeBody(types.CL, { annualQuota: 10 }))
  await call(ADMIN, 'PUT', `/leave/types/${types.SL.id}`, typeBody(types.SL, { annualQuota: 5, requiresAttachment: true }))
  // An Admin adds a leave type (a Manager may not).
  const newType = { name: 'Notice Leave', code: 'nl', annualQuota: 15, isPaid: true, allowHalfDay: true, requiresAttachment: false, maxConsecutiveDays: null, advanceNoticeDays: 3, carryForwardMax: 0, isActive: true, sortOrder: 5 }
  const added = await call(ADMIN, 'POST', '/leave/types', newType)
  const mgrAdd = await call(MGR, 'POST', '/leave/types', { ...newType, code: 'XX', name: 'Manager type' })
  types.NL = added.json
  check('1e an Admin adds a leave type (code saved in capitals); a Manager may not (403)', added.status === 201 && added.json?.code === 'NL' && mgrAdd.status === 403, `${added.status},${mgrAdd.status}`)
  await call(ADMIN, 'PUT', `/leave/types/${types.EL.id}`, typeBody(types.EL, { annualQuota: null, maxConsecutiveDays: 2, isPaid: false }))
  const off = await call(ADMIN, 'PUT', `/leave/types/${types.EL.id}`, typeBody(types.EL, { annualQuota: null, maxConsecutiveDays: 2, isPaid: false, isActive: false }))
  check('1d an Admin sets quotas and rules; switching a leave type off is the Super Admin’s alone (403)', q1.status === 200 && off.status === 403, `${q1.status},${off.status}`)
}

// ---- 2. Applying: rules
let firstLeaveId = ''
{
  const ov = await call(W, 'GET', '/worker/leave')
  check('2a the worker’s leave page: types, balances (Casual 10 left), shifts', ov.status === 200 && ov.json.balances.find((b: any) => b.code === 'CL')?.remaining === 10 && ov.json.shifts.length > 0, `${ov.status}`)

  // A range with a weekly off or holiday in it: those days are not counted.
  const states = await dayStates(parseDateKey(plus(10)), parseDateKey(plus(16)))
  const open = states.filter((d) => !d.closed).length
  const pv = await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: plus(10), endDate: plus(16) })
  check('2b a week of leave counts only the open days (weekly offs and holidays left out)', pv.status === 200 && pv.json.days === open && pv.json.skipped === 7 - open, `${pv.json?.days} of 7, ${open} open`)

  const bad = {
    endBeforeStart: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: plus(5), endDate: plus(4) }),
    halfTwoDays: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.CL.id, dayPart: 'FIRST_HALF', startDate: plus(5), endDate: plus(6) }),
    tooFarBack: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: plus(-20), endDate: plus(-19) }),
    notice: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.NL.id, dayPart: 'FULL', startDate: plus(1), endDate: plus(1) }),
    tooLong: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.EL.id, dayPart: 'FULL', startDate: plus(20), endDate: plus(30) }),
    overQuota: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: plus(40), endDate: plus(70) }),
    badDate: await call(W, 'POST', '/worker/leave/preview', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: '2026-02-30', endDate: '2026-03-01' })
  }
  const codes = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.status]))
  check('2c invalid requests refused (400): end before start, half day over two days, too far back, advance notice, too long, over the quota, impossible date', Object.values(codes).every((s) => s === 400), JSON.stringify(codes))
  // Supporting documents are not used for leave: a type cannot be set to require one, and leave is applied without one.
  const [sl] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, types.SL.id))
  const openDay = (await dayStates(parseDateKey(plus(45)), parseDateKey(plus(60)))).find((d) => !d.closed)!.date
  const noDoc = await form(W, '/worker/leave/requests', { leaveTypeId: types.SL.id, dayPart: 'FULL', startDate: openDay, endDate: openDay, reason: 'Fever' })
  const undo = noDoc.json?.id ? await call(W, 'POST', `/worker/leave/requests/${noDoc.json.id}/cancel`) : null
  check('2d no supporting document: "required" cannot be switched on; Sick Leave is applied without a document', sl.requiresAttachment === false && noDoc.status === 201 && undo?.status === 200, `${sl.requiresAttachment} ${noDoc.status} ${noDoc.json?.error ?? ''}`)

  received.length = 0
  const a = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: plus(10), endDate: plus(16), reason: 'Family function' })
  firstLeaveId = a.json?.id
  check('2e applied: PENDING, with the counted days', a.status === 201 && a.json.status === 'PENDING' && a.json.days === open, `${a.status} ${a.json?.error ?? ''}`)
  const dup = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: plus(12), endDate: plus(12), reason: 'Again' })
  check('2f an overlapping (or duplicate) request is refused (409)', dup.status === 409, dup.json?.error ?? '')

  const h1 = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'FIRST_HALF', startDate: plus(20), endDate: plus(20), reason: 'Bank work' })
  const h2 = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'SECOND_HALF', startDate: plus(20), endDate: plus(20), reason: 'Doctor' })
  const h3 = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'FIRST_HALF', startDate: plus(20), endDate: plus(20), reason: 'Again' })
  check('2g half days: 0.5 each; both halves of one date allowed, the same half twice refused', h1.status === 201 && h1.json.days === 0.5 && h2.status === 201 && h3.status === 409, `${h1.status},${h2.status},${h3.status} ${h1.json?.error ?? ''}`)

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')
  const sick = await form(W, '/worker/leave/requests', { leaveTypeId: types.SL.id, dayPart: 'FULL', startDate: plus(-1), endDate: plus(-1), reason: 'Fever' }, { name: 'note.pdf', type: 'application/pdf', bytes: pdf })
  const exe = await form(W, '/worker/leave/requests', { leaveTypeId: types.SL.id, dayPart: 'FULL', startDate: plus(-2), endDate: plus(-2), reason: 'Fever' }, { name: 'virus.exe', type: 'application/octet-stream', bytes: pdf })
  const own = await fetch(`${BASE}/worker/leave/attachment/leave/${sick.json?.id}`, { headers: { Authorization: `Bearer ${W}` } })
  const other = await fetch(`${BASE}/worker/leave/attachment/leave/${sick.json?.id}`, { headers: { Authorization: `Bearer ${W2}` } })
  const staff = await fetch(`${BASE}/leave/attachment/leave/${sick.json?.id}`, { headers: { Authorization: `Bearer ${SA}` } })
  check('2h a past sick leave with a PDF: accepted; other file types refused; the document opens for the worker and staff, not for another worker', sick.status === 201 && sick.json.hasAttachment && exe.status === 400 && own.status === 200 && other.status === 404 && staff.status === 200, `${sick.status},${exe.status},${own.status},${other.status},${staff.status}`)

  await settle()
  check('2i new request emailed to the approvers (HR), with copies to the Super Admin and CC', mailTo('hr@ok.test', /New Leave Request/).length >= 1 && mailTo('sa@ok.test', /New Leave Request/).length >= 1 && mailTo('cc@ok.test', /New Leave Request/).length >= 1, `${received.length} emails`)
  const ov2 = await call(W, 'GET', '/worker/leave')
  const cl = ov2.json.balances.find((b: any) => b.code === 'CL')
  check('2j pending days show in the balance (used 0, pending counted, remaining lowered)', cl.used === 0 && cl.pending === open + 1 && cl.remaining === 10 - open - 1, JSON.stringify(cl))
}

// ---- 3. Permissions on the admin side
{
  const asWorker = await call(await tokenFor(w.id), 'GET', '/leave/requests')
  const workerDecides = await call(W, 'POST', `/leave/requests/${firstLeaveId}/decision`, { approve: true })
  const mgrList = await call(MGR, 'GET', '/leave/requests?status=PENDING')
  const mgrCancel = await call(MGR, 'POST', `/leave/requests/${firstLeaveId}/cancel`)
  const [perm] = await db.select().from(rolePermissions).where(and(eq(rolePermissions.role, 'MANAGER'), eq(rolePermissions.module, 'leave')))
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { leave: { view: true, approve: false } } })
  const mgrNoApprove = await call(MGR, 'POST', `/leave/requests/${firstLeaveId}/decision`, { approve: true })
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { leave: { view: perm.canView, approve: perm.canApprove, edit: perm.canEdit, export: perm.canExport } } })
  const count = await call(MGR, 'GET', '/leave/pending-count')
  check(
    '3 a worker cannot read or decide (403); a Manager sees pending requests but cannot cancel (no edit) or decide without approve (403); the badge count',
    asWorker.status === 403 && workerDecides.status === 403 && mgrList.status === 200 && mgrList.json.length >= 3 && mgrCancel.status === 403 && mgrNoApprove.status === 403 && count.json.leave >= 3,
    `${asWorker.status},${workerDecides.status},${mgrList.status},${mgrCancel.status},${mgrNoApprove.status},${count.json?.leave}`
  )
}

// ---- 4. Decisions
{
  received.length = 0
  const ok = await call(MGR, 'POST', `/leave/requests/${firstLeaveId}/decision`, { approve: true, comment: 'Enjoy' })
  const again = await call(SA, 'POST', `/leave/requests/${firstLeaveId}/decision`, { approve: false })
  await settle()
  const cl = (await call(W, 'GET', '/worker/leave')).json.balances.find((b: any) => b.code === 'CL')
  check('4a approved by the Manager; deciding again is refused (409); the balance moves from pending to used', ok.status === 200 && ok.json.status === 'APPROVED' && again.status === 409 && cl.used === ok.json.days, `${ok.status},${again.status} ${JSON.stringify(cl)}`)
  const mail = mailTo('worker@ok.test', /Leave Request Approved/)
  check(
    '4b the worker’s email: "Leave Request Approved – name" with type, dates, days, approver and remarks; one email only',
    mail.length === 1 && [/Employee ID/, /Leave Type/, /Casual Leave/, /Total Leave Days/, /Approved By/, /Enjoy/].every((re) => re.test(mailText(mail[0]))),
    `${mail.length}`
  )
  const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'APPROVE_LEAVE'), eq(auditLogs.entityId, firstLeaveId)))
  check('4c audit: approver, decision, time and comment', !!log && (log.newValue as any).comment === 'Enjoy' && (log.newValue as any).decidedBy && log.userName?.includes(mgr.name))

  const pending = (await call(SA, 'GET', '/leave/requests?status=PENDING')).json as any[]
  const rej = await call(SA, 'POST', `/leave/requests/${pending.find((p) => p.dayPart === 'SECOND_HALF')?.id}/decision`, { approve: false, comment: 'Busy week' })
  await settle()
  check('4d rejected with a comment: "Rejected" email to the worker', rej.status === 200 && rej.json.status === 'REJECTED' && mailTo('worker@ok.test', /Leave Request Rejected/).length === 1)
  const logs = await db.select().from(reportEmailLogs).where(eq(reportEmailLogs.trigger, 'LEAVE'))
  check('4e leave emails are in the Delivery log as Sent', logs.length >= 3 && logs.every((l) => l.status === 'SENT'), `${logs.length}`)
}

// ---- 5. Cancelling
{
  const pending = (await call(SA, 'GET', '/leave/requests?status=PENDING')).json as any[]
  const mine = pending.find((p) => p.dayPart === 'FIRST_HALF')
  const c1 = await call(W, 'POST', `/worker/leave/requests/${mine.id}/cancel`)
  const c2 = await call(W2, 'POST', `/worker/leave/requests/${firstLeaveId}/cancel`)
  const c3 = await call(W, 'POST', `/worker/leave/requests/${firstLeaveId}/cancel`)
  const cl = (await call(W, 'GET', '/worker/leave')).json.balances.find((b: any) => b.code === 'CL')
  check('5 the worker cancels their own pending and not-yet-started approved leave (days given back); another worker cannot (404)', c1.json?.status === 'CANCELLED' && c2.status === 404 && c3.json?.status === 'CANCELLED' && cl.used === 0 && cl.pending === 0, `${c1.status},${c2.status},${c3.status} ${JSON.stringify(cl)}`)
}

// ---- 6. Approved leave and checks
{
  const [sched] = await db.select().from(schedules).where(and(eq(schedules.workerId, w.id), eq(schedules.isActive, true)))
  const [shift] = sched?.shiftId ? await db.select().from(shifts).where(eq(shifts.id, sched.shiftId)) : []
  const tomorrow = plus(1)
  const leave = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'FULL', startDate: tomorrow, endDate: tomorrow, reason: 'Check test' })
  // An open check of the worker on that day, which the approval must remove.
  const at = new Date(parseDateKey(tomorrow).getTime() + 15 * 3600_000)
  const [open] = await db
    .insert(qualityChecks)
    .values({ code: `TEST-LEAVE-${Date.now()}`, scheduleId: null, machineId: sched?.machineId ?? null, activityId: sched.activityId, module: sched.module, workerId: w.id, scheduledAt: at, windowEndsAt: new Date(at.getTime() + 15 * 60_000), status: 'PENDING' })
    .returning()
  const ok = await call(SA, 'POST', `/leave/requests/${leave.json.id}/decision`, { approve: true })
  const still = await db.select().from(qualityChecks).where(eq(qualityChecks.id, open.id))
  // The worker's own shift window that starts tomorrow (an overnight shift of today runs into tomorrow too).
  const own = occurrences(sched, shift ?? null, startOfDay(parseDateKey(tomorrow)), 2).find((o) => dateKey(o.start) === tomorrow)!
  const fmt = (list: any[]) => list.map((p) => (p.scheduledAt as Date).toISOString()).join(',')
  const plan = await slotsIn(sched.id, own.start, own.end)
  check('6a approved full-day leave: the worker’s open checks that day removed, and no check planned in that day’s shift', ok.status === 200 && still.length === 0 && plan.length === 0, `${shift?.name} planned: ${fmt(plan)}`)
  await call(SA, 'POST', `/leave/requests/${leave.json.id}/cancel`)
  const back = await slotsIn(sched.id, own.start, own.end)
  check('6b leave cancelled: checks are planned in that shift again', back.length >= 1, `${back.length} slots`)

  const half = await form(W, '/worker/leave/requests', { leaveTypeId: types.CL.id, dayPart: 'FIRST_HALF', startDate: tomorrow, endDate: tomorrow, reason: 'Half test' })
  await call(SA, 'POST', `/leave/requests/${half.json.id}/decision`, { approve: true })
  const halfPlan = await slotsIn(sched.id, own.start, own.end)
  const middle = new Date((own.start.getTime() + own.end.getTime()) / 2)
  check('6c first-half leave: the shift’s checks start in its second half', halfPlan.length >= 1 && halfPlan.length < back.length && (halfPlan[0].scheduledAt as Date) >= middle, `${fmt(halfPlan.slice(0, 1))} ≥ ${middle.toISOString()}; ${halfPlan.length} of ${back.length}`)
  await call(SA, 'POST', `/leave/requests/${half.json.id}/cancel`)
}

// ---- 7. Shift changes
{
  const ov = (await call(W, 'GET', '/worker/leave')).json
  const other = ov.shifts.find((s: any) => s.id !== ov.currentShiftId)
  const [sched] = await db.select().from(schedules).where(and(eq(schedules.workerId, w.id), eq(schedules.isActive, true)))
  const d = plus(2)
  received.length = 0
  const same = await form(W, '/worker/leave/shift-changes', { requestedShiftId: ov.currentShiftId, startDate: d, endDate: d, reason: 'Same' })
  const past = await form(W, '/worker/leave/shift-changes', { requestedShiftId: other.id, startDate: plus(-1), endDate: plus(-1), reason: 'Past' })
  const r = await form(W, '/worker/leave/shift-changes', { requestedShiftId: other.id, startDate: d, endDate: plus(3), reason: 'Exam' })
  const overlap = await form(W, '/worker/leave/shift-changes', { requestedShiftId: other.id, startDate: plus(3), endDate: plus(4), reason: 'Again' })
  check('7a shift change: own shift and past dates refused (400), overlap refused (409), a valid one PENDING', same.status === 400 && past.status === 400 && r.status === 201 && r.json.status === 'PENDING' && overlap.status === 409, `${same.status},${past.status},${r.status},${overlap.status}`)
  const [shiftRow] = await db.select().from(shifts).where(eq(shifts.id, other.id))
  const win = occurrences({ ...sched, startTime: null, endTime: null } as any, shiftRow, startOfDay(parseDateKey(d)), 2).find((o) => dateKey(o.start) === d)!
  const asOther = (list: any[]) => list.filter((p) => p.shiftId === other.id)
  const before = asOther(await slotsIn(sched.id, win.start, win.end))
  const ok = await call(MGR, 'POST', `/leave/shift-changes/${r.json.id}/decision`, { approve: true, comment: 'OK' })
  const after = asOther(await slotsIn(sched.id, win.start, win.end))
  const startHHMM = (x: any) => new Date(x.scheduledAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
  check(
    '7b approved: on those dates the worker’s checks follow the requested shift (its start and shift id)',
    ok.status === 200 && before.length === 0 && after.length >= 1 && startHHMM(after[0]) === other.startTime,
    `before ${before.length} after ${after.length} from ${after[0] ? startHHMM(after[0]) : '-'} (${other.name} ${other.startTime})`
  )
  await settle()
  check('7c emails: new request to the approvers, decision to the worker', mailTo('hr@ok.test', /New Shift Change Request/).length === 1 && mailTo('worker@ok.test', /Shift Change Request Approved/).length === 1)
  const sc = await call(SA, 'GET', `/leave/shift-changes?workerId=${w.id}`)
  check('7d shift change list for approvers', sc.status === 200 && sc.json.some((x: any) => x.id === r.json.id && x.requestedShiftName === other.name))
  await call(SA, 'POST', `/leave/shift-changes/${r.json.id}/cancel`)
  const restored = asOther(await slotsIn(sched.id, win.start, win.end))
  check('7e cancelled: the worker’s own shift again (no checks in the requested shift)', restored.length === 0, `${restored.length}`)
}

// ---- 8. Approving at any time; no reminders
{
  // The sick leave of yesterday (2h) is still pending: an Admin approves it although its date has passed.
  const pending = (await call(SA, 'GET', '/leave/requests?status=PENDING')).json as any[]
  const past = pending.find((p) => p.endDate < today)
  const ok = past ? await call(ADMIN, 'POST', `/leave/requests/${past.id}/decision`, { approve: true, comment: 'Late approval' }) : { status: 0, json: null }
  check('8a an Admin approves a leave whose date has already passed', ok.status === 200 && ok.json?.status === 'APPROVED', `${ok.status} ${ok.json?.error ?? ''}`)
  const cols = await db.execute(sql`select column_name from information_schema.columns where table_name in ('leave_requests', 'shift_change_requests') and column_name in ('reminded_at', 'escalated_at')`)
  const s = (await call(SA, 'GET', '/leave/settings')).json
  check('8b reminders and escalation are gone (no columns, no setting)', cols.rows.length === 0 && !('reminders' in s), `${cols.rows.length} ${Object.keys(s).join(',')}`)
}

// ---- 9. Calendar, report, feature switch
{
  const cal = await call(SA, 'GET', `/leave/calendar?from=${plus(-5)}&to=${plus(40)}`)
  const rep = await call(SA, 'GET', '/leave/report')
  const row = rep.json.rows.find((r: any) => r.workerId === w.id)
  check('9a calendar (leave, shift changes, closed days) and report (each worker’s balance per type)', cal.status === 200 && Array.isArray(cal.json.closedDays) && rep.status === 200 && row?.balances.some((b: any) => b.code === 'CL'))
  await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_leave: { create: false } } })
  const offPage = await call(W, 'GET', '/worker/leave')
  await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_leave: { create: true } } })
  check('9b with "Leave in the app" switched off the worker gets 403', offPage.status === 403)
}

// ---- 11. Custom Leave: the employee enters the leave's own name; it goes for approval like any leave
{
  const [custom] = await db.select().from(leaveTypes).where(eq(leaveTypes.code, 'CUSTOM'))
  check('11a migration: a Custom Leave type, active, no limit, employee names it', !!custom && custom.isCustom && custom.isActive && custom.annualQuota === null)
  const ov = (await call(W, 'GET', '/worker/leave')).json
  const day = (await dayStates(parseDateKey(plus(70)), parseDateKey(plus(90)))).find((d) => !d.closed)!.date
  const noName = await form(W, '/worker/leave/requests', { leaveTypeId: custom.id, dayPart: 'FULL', startDate: day, endDate: day, reason: 'Family wedding' })
  received.length = 0
  const ok = await form(W, '/worker/leave/requests', { leaveTypeId: custom.id, customType: 'Marriage leave', dayPart: 'FULL', startDate: day, endDate: day, reason: 'Family wedding' })
  check(
    '11b the worker app lists it as custom; without a leave name it is refused (400); with one it is sent, PENDING, as "Custom Leave – Marriage leave"',
    ov.types.some((t: any) => t.id === custom.id && t.isCustom) && noName.status === 400 && ok.status === 201 && ok.json?.status === 'PENDING' && ok.json?.leaveTypeName === 'Custom Leave – Marriage leave',
    `${noName.status} ${noName.json?.error ?? ''} | ${ok.status} ${ok.json?.leaveTypeName ?? ok.json?.error}`
  )
  const pending = (await call(MGR, 'GET', '/leave/requests?status=PENDING')).json as any[]
  await settle()
  check('11c it reaches the approvers: in Approvals and in the "New Leave Request" email, with its name', pending.some((p) => p.id === ok.json.id && p.leaveTypeName.includes('Marriage leave')) && mailTo('hr@ok.test', /New Leave Request/).some((m) => mailText(m).includes('Marriage leave')))
  const decided = await call(MGR, 'POST', `/leave/requests/${ok.json.id}/decision`, { approve: true, comment: 'Congratulations' })
  check('11d a Manager approves it (Admins and the Super Admin may too)', decided.status === 200 && decided.json?.status === 'APPROVED', `${decided.status}`)
}

// ---- 10. Deleting leave types
{
  const unused = await call(ADMIN, 'POST', '/leave/types', { name: 'Temporary Leave', code: 'TMP', annualQuota: 1, isPaid: true, allowHalfDay: false, requiresAttachment: false, maxConsecutiveDays: null, advanceNoticeDays: 0, carryForwardMax: 0, isActive: true, sortOrder: 9 })
  const mgrDel = await call(MGR, 'DELETE', `/leave/types/${unused.json.id}`)
  const del = await call(ADMIN, 'DELETE', `/leave/types/${unused.json.id}`)
  const gone = (await db.select().from(leaveTypes).where(eq(leaveTypes.id, unused.json.id))).length === 0
  check('10a an Admin deletes an unused leave type (a Manager may not: 403)', mgrDel.status === 403 && del.status === 200 && del.json?.result === 'deleted' && gone, `${mgrDel.status},${del.status}`)
  const used = await call(ADMIN, 'DELETE', `/leave/types/${types.CL.id}`)
  const saUsed = await call(SA, 'DELETE', `/leave/types/${types.CL.id}`)
  const [cl] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, types.CL.id))
  check('10b a type in use is kept for its requests: the Admin is told (409); the Super Admin switches it off', used.status === 409 && saUsed.json?.result === 'disabled' && cl && !cl.isActive, `${used.status} ${used.json?.error ?? ''} ${saUsed.json?.result}`)
  const audits = await db.select().from(auditLogs).where(inArray(auditLogs.action, ['DELETE_LEAVE_TYPE', 'DISABLE_LEAVE_TYPE', 'CREATE_LEAVE_TYPE']))
  check('10c adding and deleting leave types is in the audit log', audits.length >= 4, `${audits.length}`)
}

server.close()
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
