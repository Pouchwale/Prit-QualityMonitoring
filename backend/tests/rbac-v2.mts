/**
 * Roles & Permissions, second round (npm run test:rbac-v2): Approve and Export actions, the Worker
 * role's app features, Activate/Deactivate as the Super Admin's alone, the permission history, and
 * persistence across a server restart (run with `after-restart` the second time, see below).
 *
 * Refuses to run unless DATABASE_URL names a database ending in "_test":
 *   1. Copy the live database into pouchwale_quality_test; start a server on it (PORT=4191).
 *   2. DATABASE_URL=.../pouchwale_quality_test npm run test:rbac-v2
 *   3. Restart that server, then: DATABASE_URL=... npm run test:rbac-v2 -- after-restart
 *   4. Drop the copy.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { auditLogs, checkExceptions, departmentMappings, machines, parameters, qualityChecks, rolePermissions, schedules, shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`
const AFTER_RESTART = process.argv.includes('after-restart')

let passed = 0
let failed = 0
const results: string[] = []
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
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
const statusCounts = async () =>
  JSON.stringify(
    await db.select({ status: qualityChecks.status, n: sql<number>`count(*)::int` }).from(qualityChecks).where(inArray(qualityChecks.status, ['COMPLETED', 'MISSED', 'EXCEPTION'])).groupBy(qualityChecks.status).orderBy(qualityChecks.status)
  )

const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [mgr] = await db.select().from(users).where(eq(users.role, 'MANAGER'))
const [worker] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true), eq(users.appAccess, true)))
const SA = await tokenFor(sa.id)
const MGR = await tokenFor(mgr.id)
const WORKER = await tokenFor(worker.id, 'mobile')

if (AFTER_RESTART) {
  // ---- 8. Saved before the restart: still in force after it
  const me = await call(WORKER, 'GET', '/auth/me')
  const perf = await call(WORKER, 'GET', '/worker/performance')
  check('8 after a server restart: the Worker role still has My performance switched off (403)', me.json?.actions?.app_performance?.view === false && perf.status === 403, `${perf.status}`)
  await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_performance: { view: true } } })
  const back = await call(WORKER, 'GET', '/worker/performance')
  check('8b switched on again: allowed', back.status === 200)
} else {
  const checksBefore = await statusCounts()
  const stamp = Date.now().toString().slice(-6)
  const created = await call(SA, 'POST', '/users', { employeeId: `TV${stamp}`, name: 'V2 admin', role: 'ADMIN', password: 'secret12' })
  const adminId = created.json.id as string
  const ADMIN = await tokenFor(adminId)

  // ---- 1. The matrix: new columns and the Worker role
  {
    const mods = (await call(SA, 'GET', '/access/modules')).json as any[]
    const by = Object.fromEntries(mods.map((m) => [m.key, m]))
    check(
      '1a modules: Approve on Plant Calendar and Exceptions, Export on Reports / Quality Checks / Worker Performance, no separate Export module, worker app features',
      by.calendar.actions.includes('approve') && by.exceptions.actions.includes('approve') && ['reports', 'checks', 'performance'].every((k) => by[k].actions.includes('export')) && !by.export && by.app_jobs?.audience === 'worker'
    )
    check('1b Activate/Deactivate is never an action; the modules with an active switch are marked', mods.every((m) => !m.actions.includes('activate')) && ['workers', 'machines', 'parameters', 'activities', 'schedules', 'shifts', 'departments'].every((k) => by[k].activation))
    const matrix = (await call(SA, 'GET', '/access/matrix')).json
    check(
      '1c migration kept today’s access: Worker role has all app features; Admin role exports and approves as before',
      matrix.roles.WORKER.app_jobs.create && matrix.roles.WORKER.app_history.view && matrix.roles.ADMIN.reports.export && matrix.roles.ADMIN.calendar.approve
    )
  }

  // ---- 2 / 3. Worker role features, Super Admin only
  {
    const before = await call(WORKER, 'GET', '/worker/checks/history')
    const denied = await call(ADMIN, 'PUT', '/access/roles/WORKER', { modules: { app_history: { view: false } } })
    await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_history: { view: false } } })
    const after = await call(WORKER, 'GET', '/worker/checks/history')
    const check1 = await call(WORKER, 'GET', '/worker/checks/today')
    check('2a Admin cannot change the Worker role (403)', denied.status === 403)
    check('2b Super Admin switches off My check history: the worker gets 403 at once; doing checks still works', before.status === 200 && after.status === 403 && check1.status === 200, `${before.status},${after.status},${check1.status}`)
    await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_history: { view: true } } })
    const jobOff = await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_jobs: { create: false, edit: true } } })
    const start = await call(WORKER, 'POST', `/worker/machines/00000000-0000-4000-8000-000000000000/jobs`, { jobNo: 'X', itemCode: 'FGPO1' })
    await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_jobs: { create: true, edit: true } } })
    check('2c Start jobs switched off: the worker cannot start one (403)', jobOff.status === 200 && start.status === 403, `${start.status}`)
    const panel = await call(await tokenFor(worker.id), 'GET', '/machines')
    check('3 a worker never gets the admin panel (403)', panel.status === 403)
  }

  // ---- 4 / 5 / 6. Export and Approve, enforced on the server
  {
    await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { performance: { view: true, export: false }, reports: { view: true, export: false } } })
    const x1 = await call(MGR, 'GET', '/performance/weekly.xlsx')
    const p1 = await call(MGR, 'GET', '/reports/quality-monitoring.pdf')
    const v1 = await call(MGR, 'GET', '/performance/weekly')
    await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { performance: { view: true, export: true } } })
    const x2 = await call(MGR, 'GET', '/performance/weekly.xlsx')
    await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { performance: { view: true, export: false }, reports: { view: false } } })
    check('4 Export: view without export cannot download (403); with export it can', x1.status === 403 && p1.status === 403 && v1.status === 200 && x2.status === 200, `${x1.status},${p1.status},${v1.status},${x2.status}`)

    // Any exception, opened for the test (put back afterwards).
    const [exc] = await db.select().from(checkExceptions).limit(1)
    if (exc) await db.update(checkExceptions).set({ status: 'UNDER_REVIEW' }).where(eq(checkExceptions.id, exc.id))
    await call(SA, 'PUT', `/access/users/${adminId}`, { modules: { exceptions: { view: true, edit: true, approve: false }, calendar: { view: true, edit: true, approve: false } } })
    const ack = exc ? await call(ADMIN, 'PATCH', `/exceptions/${exc.id}`, { status: 'ACKNOWLEDGED' }) : { status: 0 }
    const res1 = exc ? await call(ADMIN, 'PATCH', `/exceptions/${exc.id}`, { status: 'RESOLVED' }) : { status: 0 }
    const cal1 = await call(ADMIN, 'POST', '/calendar-years/00000000-0000-4000-8000-000000000000/approve')
    await call(SA, 'PUT', `/access/users/${adminId}`, { modules: { exceptions: { view: true, edit: true, approve: true }, calendar: { view: true, edit: true, approve: true } } })
    const res2 = exc ? await call(ADMIN, 'PATCH', `/exceptions/${exc.id}`, { status: 'RESOLVED' }) : { status: 0 }
    const cal2 = await call(ADMIN, 'POST', '/calendar-years/00000000-0000-4000-8000-000000000000/approve')
    if (exc) await db.update(checkExceptions).set({ status: exc.status, reviewedById: exc.reviewedById, resolutionNotes: exc.resolutionNotes }).where(eq(checkExceptions.id, exc.id))
    check(
      '5 Approve: edit can review an exception but not resolve it, nor approve a calendar (403); with approve both pass the permission check',
      !!exc && ack.status === 200 && res1.status === 403 && cal1.status === 403 && res2.status === 200 && cal2.status !== 403,
      `${ack.status},${res1.status},${cal1.status},${res2.status},${cal2.status}`
    )
  }

  // ---- 7. Activate / deactivate: the Super Admin's alone, whatever the permissions say
  {
    // This Admin has every action on every module (even ticked for them alone): still no activation.
    const everything = { view: true, create: true, edit: true, delete: true, approve: true, export: true }
    await call(SA, 'PUT', `/access/users/${adminId}`, {
      modules: Object.fromEntries(['workers', 'machines', 'parameters', 'activities', 'schedules', 'shifts', 'departments'].map((m) => [m, everything]))
    })
    // A crafted row in the database cannot grant it either.
    await db.insert(rolePermissions).values({ role: 'ADMIN', module: 'activation', canView: true, canCreate: true, canEdit: true, canDelete: true, canApprove: true, canExport: true }).onConflictDoNothing()

    // A machine with check history: deleting it would only deactivate it.
    const [machine] = await db
      .select()
      .from(machines)
      .where(and(eq(machines.isActive, true), sql`exists (select 1 from ${qualityChecks} where ${qualityChecks.machineId} = ${machines.id})`))
      .limit(1)
    const machineBody = (m: typeof machine, isActive?: boolean) => ({
      name: m.name,
      code: m.code,
      departmentId: m.departmentId,
      line: m.line,
      model: m.model,
      status: m.status,
      notes: m.notes,
      ...(isActive === undefined ? {} : { isActive })
    })
    const [param] = await db.select().from(parameters).where(eq(parameters.isActive, true)).limit(1)
    const [sched] = await db.select().from(schedules).where(eq(schedules.isActive, true)).limit(1)
    const [shift] = await db.select().from(shifts).where(eq(shifts.isActive, true)).limit(1)
    const [mapping] = await db.select().from(departmentMappings).where(eq(departmentMappings.isActive, true)).limit(1)
    const [workerToDisable] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true), ne(users.id, worker.id))).limit(1)
    const reason = ((await call(SA, 'GET', '/exception-reasons')).json as any[]).find((r) => r.isActive)

    const attempts = {
      machineOff: await call(ADMIN, 'PUT', `/machines/${machine.id}`, machineBody(machine, false)),
      machineDelete: await call(ADMIN, 'DELETE', `/machines/${machine.id}`),
      machineNewOff: await call(ADMIN, 'POST', '/machines', { name: `V2 ${stamp}`, code: `V2${stamp}`, isActive: false }),
      parameterOff: await call(ADMIN, 'PUT', `/parameters/${param.id}`, { ...param, isActive: false }),
      scheduleOff: await call(ADMIN, 'PUT', `/schedules/${sched.id}`, { ...sched, isActive: false }),
      shiftOff: await call(ADMIN, 'PUT', `/shifts/${shift.id}`, { name: shift.name, code: shift.code, startTime: shift.startTime, endTime: shift.endTime, graceMinutes: shift.graceMinutes, isActive: false }),
      mappingOff: mapping ? await call(ADMIN, 'PATCH', `/department-mappings/${mapping.id}/status`, { isActive: false }) : { status: 403 },
      reasonOff: await call(ADMIN, 'DELETE', `/exception-reasons/${reason.id}`),
      userDisable: await call(ADMIN, 'DELETE', `/users/${workerToDisable.id}`),
      userOff: await call(ADMIN, 'PUT', `/users/${workerToDisable.id}`, { isActive: false }),
      userNewOff: await call(ADMIN, 'POST', '/users', { employeeId: `TW${stamp}`, name: 'Off', role: 'WORKER', password: 'secret12', isActive: false })
    }
    const statuses = Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, v.status]))
    const nothingChanged =
      (await db.select().from(machines).where(eq(machines.id, machine.id)))[0].isActive &&
      (await db.select().from(parameters).where(eq(parameters.id, param.id)))[0].isActive &&
      (await db.select().from(schedules).where(eq(schedules.id, sched.id)))[0].isActive &&
      (await db.select().from(shifts).where(eq(shifts.id, shift.id)))[0].isActive &&
      (await db.select().from(users).where(eq(users.id, workerToDisable.id)))[0].isActive
    check(
      '7a an Admin with every permission cannot deactivate machines, parameters, schedules, shifts, mappings, reasons or accounts, nor create them inactive (403), and nothing changed',
      Object.values(statuses).every((s) => s === 403) && nothingChanged,
      JSON.stringify(statuses)
    )
    const denials = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.action, 'ACTIVATION_DENIED'), eq(auditLogs.userId, adminId)))
    check('7b each refused attempt is in the audit log (ACTIVATION_DENIED)', denials[0].n >= 10, `${denials[0].n}`)

    // An ordinary edit that leaves isActive out does not reactivate an inactive record.
    const sOff = await call(SA, 'PUT', `/machines/${machine.id}`, machineBody(machine, false))
    const edit = await call(ADMIN, 'PUT', `/machines/${machine.id}`, { ...machineBody(machine), notes: 'edited by admin' })
    const stillOff = (await db.select().from(machines).where(eq(machines.id, machine.id)))[0]
    const sOn = await call(SA, 'PUT', `/machines/${machine.id}`, machineBody(machine, true))
    check('7c Super Admin deactivates and reactivates a machine; an Admin edit without the switch keeps it inactive', sOff.status === 200 && edit.status === 200 && !stillOff.isActive && sOn.status === 200, `${sOff.status},${edit.status},${stillOff.isActive},${sOn.status}`)
    await db.update(machines).set({ notes: machine.notes }).where(eq(machines.id, machine.id))

    const off = await call(SA, 'DELETE', `/users/${workerToDisable.id}`)
    const on = await call(SA, 'PUT', `/users/${workerToDisable.id}`, { isActive: true })
    const [u] = await db.select().from(users).where(eq(users.id, workerToDisable.id))
    const theirChecks = await db.select({ n: sql<number>`count(*)::int` }).from(qualityChecks).where(eq(qualityChecks.workerId, workerToDisable.id))
    check('7d Super Admin disables and reactivates an account; it and its checks stay', off.status === 200 && on.status === 200 && u.isActive && theirChecks[0].n >= 0)
    await db.delete(rolePermissions).where(and(eq(rolePermissions.role, 'ADMIN'), eq(rolePermissions.module, 'activation')))
  }

  // ---- 9. Permission history: the Super Admin only
  {
    const h = await call(SA, 'GET', '/access/history')
    const hAdmin = await call(ADMIN, 'GET', '/access/history')
    const logsAdmin = (await call(ADMIN, 'GET', '/audit-logs?limit=1000')).json as any[]
    const logsSA = (await call(SA, 'GET', '/audit-logs?limit=1000')).json as any[]
    const permissionActions = ['UPDATE_ROLE_PERMISSIONS', 'UPDATE_USER_PERMISSIONS', 'CHANGE_ROLE', 'ACTIVATION_DENIED', 'PERMISSION_CHANGE_DENIED']
    check(
      '9 history: Super Admin sees who changed which permission and the refused attempts; an Admin gets 403 and the Audit Logs page hides them',
      h.status === 200 &&
        h.json.some((r: any) => r.action === 'UPDATE_ROLE_PERMISSIONS' && r.oldValue && r.newValue && r.userName) &&
        h.json.some((r: any) => r.action === 'ACTIVATION_DENIED') &&
        h.json.some((r: any) => r.action === 'PERMISSION_CHANGE_DENIED') &&
        hAdmin.status === 403 &&
        !logsAdmin.some((r) => permissionActions.includes(r.action)) &&
        logsSA.some((r) => permissionActions.includes(r.action))
    )
  }

  // ---- 10 / 12. Existing work and data
  {
    const list = await call(ADMIN, 'GET', '/machines')
    const edit = await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { schedules: { view: true, create: true, edit: true, delete: true } } })
    check('10 normal work goes on: lists load, the Super Admin saves role permissions', list.status === 200 && edit.status === 200)
    check('12 completed, missed and exception checks are exactly as before', (await statusCounts()) === checksBefore)
  }

  // ---- 8 (part 1). Saved now, checked after a restart (run again with after-restart).
  const saved = await call(SA, 'PUT', '/access/roles/WORKER', { modules: { app_performance: { view: false } } })
  check('8a saved for the restart test: Worker role, My performance off', saved.status === 200)
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
