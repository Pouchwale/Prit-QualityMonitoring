/**
 * Roles & Permissions tests (npm run test:rbac). They create accounts and change permissions, so they
 * refuse to run unless DATABASE_URL names a database ending in "_test":
 *
 *   1. Copy the live database:  createdb pouchwale_quality_test, then pg_dump pouchwale_quality |
 *      pg_restore -d pouchwale_quality_test
 *   2. Start a server on the copy (migrations run at start):
 *      DATABASE_URL=postgres://.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 npm start
 *   3. DATABASE_URL=postgres://.../pouchwale_quality_test npm run test:rbac   (RBAC_API overrides the address)
 *   4. Drop the copy.
 *
 * Section 0 checks what migration 0040 made of the plant's Manager role, so run it on a fresh copy.
 */
import { eq, and, desc, inArray } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { users, auditLogs, rolePermissions, userPermissions, qualityChecks } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'

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

async function tokenFor(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, 'web').accessToken
}
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let json: any = null
  const text = await res.text()
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}
const lastAudit = async (action: string, entityId?: string) => {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(entityId ? and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)) : eq(auditLogs.action, action))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1)
  return rows[0]
}
const full = { view: true, create: true, edit: true, delete: true }
const off = { view: false, create: false, edit: false, delete: false }

const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const [mgr] = await db.select().from(users).where(eq(users.role, 'MANAGER'))
const SA = await tokenFor(sa.id)
const stamp = Date.now().toString().slice(-6)

// ---- 0. The stored roles (whatever the Super Admin has set since migration 0040)
{
  const rows = await db.select().from(rolePermissions)
  const stored = (role: string, module: string) => rows.find((r) => r.role === role && r.module === module)
  const me = await call(await tokenFor(mgr.id), 'GET', '/auth/me')
  const a = me.json.actions as Record<string, Record<string, boolean>>
  const mismatch = Object.keys(a).filter((m) => {
    const r = stored('MANAGER', m)
    return a[m].view !== !!r?.canView || a[m].create !== !!r?.canCreate || a[m].edit !== !!r?.canEdit || a[m].delete !== !!r?.canDelete
  })
  check('0a a Manager’s session has exactly the Manager role’s stored permissions (no own rows)', me.status === 200 && mismatch.length === 0, mismatch.join(', '))
  const summary = me.json.permissions as Record<string, string>
  check('0b the older one-word summary matches (manage = any of create, edit, delete, approve)', Object.keys(a).every((m) => summary[m] === (a[m].create || a[m].edit || a[m].delete || a[m].approve ? 'manage' : a[m].view || a[m].export ? 'view' : 'none')))
  // can_manage = any of create, edit, delete, approve; a write implies view, except for worker app
  // features that have no view action (Jobs in the app: start and end only).
  check(
    '0c stored rows are consistent (can_manage = any write, a write implies view)',
    rows.every((r) => r.canManage === (r.canCreate || r.canEdit || r.canDelete || r.canApprove) && (!r.canManage || r.canView || r.module === 'app_jobs' || r.module === 'app_leave'))
  )
  const adminRows = rows.filter((r) => r.role === 'ADMIN')
  check('0d the Admin role has a row for each of the 21 modules', adminRows.length === 21, `${adminRows.length}`)
}

// Accounts for the tests, created by the Super Admin through the API.
const mk = async (role: string, n: string) => {
  const r = await call(SA, 'POST', '/users', { employeeId: `T${role[0]}${n}${stamp}`, name: `Test ${role} ${n}`, role, password: 'secret12', appAccess: true })
  if (r.status !== 201) throw new Error(`create ${role}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id as string
}
const adminId = await mk('ADMIN', 'A')
const mgr2Id = await mk('MANAGER', 'B')
const workerId = await mk('WORKER', 'C')
const ADMIN = await tokenFor(adminId)
let MGR2 = await tokenFor(mgr2Id)

// ---- 1. Super Admin manages the matrix; others are refused
{
  const m = await call(SA, 'GET', '/access/matrix')
  check('1a Super Admin opens Roles & Permissions', m.status === 200 && !!m.json.roles.ADMIN && !!m.json.roles.MANAGER)
  const a = await call(ADMIN, 'GET', '/access/matrix')
  const b = await call(ADMIN, 'PUT', '/access/roles/MANAGER', { modules: { machines: full } })
  const c = await call(ADMIN, 'PUT', `/access/users/${mgr2Id}`, { modules: { machines: full } })
  const d = await call(ADMIN, 'PUT', '/access/roles/ADMIN', { modules: { wifi_rule: full } })
  check('1b Admin cannot view or change permissions (incl. own role)', [a, b, c, d].every((r) => r.status === 403), [a, b, c, d].map((r) => r.status).join())
  const e = await call(MGR2, 'GET', '/access/matrix')
  const f = await call(MGR2, 'PUT', '/access/roles/MANAGER', { modules: { workers: full } })
  check('1c Manager cannot view or change permissions', e.status === 403 && f.status === 403)
}

// ---- 2. Deny by default and per-action enforcement (Manager role, machines)
{
  const g0 = await call(MGR2, 'POST', '/machines', { name: 'x', code: 'x' })
  check('2a Manager without Machines: create refused', g0.status === 403)
  let r = await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { machines: { view: true } } })
  check('2b Super Admin grants Machines view to Manager role (audited)', r.status === 200 && r.json.changed.length === 1 && !!(await lastAudit('UPDATE_ROLE_PERMISSIONS', 'MANAGER')))
  const g1 = await call(MGR2, 'GET', '/machines')
  const p1 = await call(MGR2, 'POST', '/machines', { name: `RBAC M ${stamp}`, code: `RB${stamp}` })
  check('2c view only: list 200, create 403 (applies without signing in again)', g1.status === 200 && p1.status === 403, `${g1.status},${p1.status}`)
  r = await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { machines: { view: true, create: true } } })
  const p2 = await call(MGR2, 'POST', '/machines', { name: `RBAC M ${stamp}`, code: `RB${stamp}` })
  const mid = p2.json?.id
  const u2 = await call(MGR2, 'PUT', `/machines/${mid}`, { name: `RBAC M2 ${stamp}`, code: `RB${stamp}` })
  const d2 = await call(MGR2, 'DELETE', `/machines/${mid}`)
  check('2d create granted: create 201, edit 403, delete 403', p2.status === 201 && u2.status === 403 && d2.status === 403, `${p2.status},${u2.status},${d2.status}`)
  // clean up and restore
  await call(SA, 'DELETE', `/machines/${mid}`)
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { machines: off } })
  const g3 = await call(MGR2, 'GET', '/machines/x-not-a-route')
  const p3 = await call(MGR2, 'POST', '/machines', { name: 'x', code: 'x' })
  check('2e revoked: create refused again', p3.status === 403, `${g3.status},${p3.status}`)
  const bad = await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { dashboard: { view: true, delete: true } } })
  const mat = await call(SA, 'GET', '/access/matrix')
  check('2f actions that do not apply are never stored (Dashboard delete)', bad.status === 200 && mat.json.roles.MANAGER.dashboard.delete === false)
}

// ---- 3. Per-user permissions replace the role's for that module only
{
  const r = await call(SA, 'PUT', `/access/users/${mgr2Id}`, { modules: { parameters: full } })
  const other = await call(await tokenFor(mgr.id), 'POST', '/parameters', {})
  const mine = await call(MGR2, 'POST', '/parameters', {})
  check('3a one Manager given Parameters create: they pass the permission check, other Managers do not', r.status === 200 && mine.status !== 403 && other.status === 403, `${mine.status},${other.status}`)
  check('3b audited as UPDATE_USER_PERMISSIONS', !!(await lastAudit('UPDATE_USER_PERMISSIONS', mgr2Id)))
  const d = await call(SA, 'GET', `/access/users/${mgr2Id}`)
  check('3c GET shows role, own rows and the result', d.status === 200 && d.json.overrides.parameters?.create === true && d.json.effective.parameters.delete === true)
  const back = await call(SA, 'PUT', `/access/users/${mgr2Id}`, { modules: { parameters: null } })
  const mine2 = await call(MGR2, 'POST', '/parameters', {})
  check('3d back to the role: refused again', back.status === 200 && mine2.status === 403)
  const self = await call(SA, 'PUT', `/access/users/${sa.id}`, { modules: { parameters: off } })
  check('3e Super Admin permissions cannot be changed', self.status === 403 || self.status === 400, String(self.status))
}

// ---- 4. One-click promotion keeps the account and its history
{
  const [before] = await db.select().from(users).where(eq(users.id, workerId))
  const oldToken = await tokenFor(workerId)
  const r = await call(SA, 'PUT', `/users/${workerId}/role`, { role: 'MANAGER' })
  const [after] = await db.select().from(users).where(eq(users.id, workerId))
  check('4a Worker → Manager: same account (id, employee ID, password)', r.status === 200 && after.id === before.id && after.employeeId === before.employeeId && after.passwordHash === before.passwordHash && after.role === 'MANAGER')
  check('4b signed out everywhere (old session refused)', (await call(oldToken, 'GET', '/auth/me')).status === 401)
  const au = await lastAudit('CHANGE_ROLE', workerId)
  check('4c audited as CHANGE_ROLE with old and new role', !!au && (au.oldValue as any)?.role === 'WORKER' && (au.newValue as any)?.role === 'MANAGER')
  const me = await call(await tokenFor(workerId), 'GET', '/auth/me')
  check('4d the new sign-in has the Manager role’s permissions', me.status === 200 && me.json.role === 'MANAGER' && me.json.permissions.calendar === 'manage')
}

// ---- 5. Demotion with history: a real worker’s checks stay theirs
{
  const [w] = await db.select().from(users).where(and(eq(users.role, 'WORKER'), eq(users.isActive, true)))
  const checksBefore = (await db.select({ id: qualityChecks.id }).from(qualityChecks).where(eq(qualityChecks.workerId, w.id))).length
  const up = await call(SA, 'PUT', `/users/${w.id}/role`, { role: 'ADMIN' })
  const down = await call(SA, 'PUT', `/users/${w.id}/role`, { role: 'WORKER' })
  const checksAfter = (await db.select({ id: qualityChecks.id }).from(qualityChecks).where(eq(qualityChecks.workerId, w.id))).length
  const [still] = await db.select().from(users).where(eq(users.id, w.id))
  check('5a promote then demote a worker: history kept, account the same', up.status === 200 && down.status === 200 && checksBefore === checksAfter && still.role === 'WORKER', `${checksBefore} checks before, ${checksAfter} after`)
  // own permissions are removed with a role change
  await call(SA, 'PUT', `/access/users/${mgr2Id}`, { modules: { machines: full } })
  await call(SA, 'PUT', `/users/${mgr2Id}/role`, { role: 'ADMIN' })
  const own = await db.select().from(userPermissions).where(eq(userPermissions.userId, mgr2Id))
  check('5b a role change removes permissions set for the user alone', own.length === 0)
  await call(SA, 'PUT', `/users/${mgr2Id}/role`, { role: 'MANAGER' })
  MGR2 = await tokenFor(mgr2Id)
}

// ---- 6. Only the Super Admin changes roles; no privilege escalation
{
  const a = await call(ADMIN, 'PUT', `/users/${mgr2Id}/role`, { role: 'ADMIN' })
  const b = await call(ADMIN, 'PUT', `/users/${adminId}/role`, { role: 'SUPER_ADMIN' })
  const [m2] = await db.select().from(users).where(eq(users.id, mgr2Id))
  const c = await call(ADMIN, 'PUT', `/users/${mgr2Id}`, { role: 'ADMIN' })
  const [me] = await db.select().from(users).where(eq(users.id, adminId))
  const d = await call(ADMIN, 'PUT', `/users/${adminId}`, { role: 'SUPER_ADMIN' })
  const e = await call(ADMIN, 'POST', '/users', { employeeId: `TX${stamp}`, name: 'Sneaky', role: 'SUPER_ADMIN', password: 'secret12' })
  const f = await call(ADMIN, 'POST', '/users', { employeeId: `TY${stamp}`, name: 'Sneaky', role: 'MANAGER', password: 'secret12' })
  const g = await call(MGR2, 'PUT', `/users/${mgr2Id}/role`, { role: 'SUPER_ADMIN' })
  const [after] = await db.select().from(users).where(eq(users.id, adminId))
  check(
    '6a Admin: cannot promote others or self, via either route or by creating accounts',
    [a, b, c, d, e, f].every((r) => r.status === 403) && after.role === 'ADMIN' && m2.role === 'MANAGER',
    [a, b, c, d, e, f].map((r) => r.status).join()
  )
  check('6b Manager cannot promote themselves to Super Admin', g.status === 403)
  const h = await call(SA, 'PUT', `/users/${sa.id}/role`, { role: 'ADMIN' })
  check('6c Super Admin cannot change their own role', h.status === 403)
  void me
}

// ---- 7. Transactions: a failed save changes nothing
{
  const [other] = await db.select().from(users).where(eq(users.id, mgr.id))
  const r = await call(SA, 'PUT', `/users/${mgr2Id}`, { role: 'ADMIN', employeeId: other.employeeId }) // duplicate employee ID
  const [m2] = await db.select().from(users).where(eq(users.id, mgr2Id))
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'CHANGE_ROLE'), eq(auditLogs.entityId, mgr2Id))).orderBy(desc(auditLogs.createdAt)).limit(1)
  check('7a role change + invalid field in one save: rejected, role unchanged, no CHANGE_ROLE audit kept', r.status >= 400 && m2.role === 'MANAGER' && (audits[0]?.newValue as any)?.role !== 'ADMIN', `status ${r.status}`)
}

// ---- 8. Employee Management actions for Admins (matrix, no isAdmin bypass)
{
  const a = await call(ADMIN, 'POST', '/users', { employeeId: `TW${stamp}`, name: 'Admin-made worker', role: 'WORKER', password: 'secret12' })
  check('8a Admin with Employee Management create adds a Worker', a.status === 201)
  await call(SA, 'PUT', `/access/users/${adminId}`, { modules: { workers: { view: true, create: false, edit: true, delete: false } } })
  const b = await call(ADMIN, 'POST', '/users', { employeeId: `TV${stamp}`, name: 'Blocked', role: 'WORKER', password: 'secret12' })
  const c = await call(ADMIN, 'DELETE', `/users/${a.json.id}`)
  const d = await call(ADMIN, 'PUT', `/users/${a.json.id}`, { name: 'Admin-made worker 2' })
  check('8b create taken away from this Admin, and disabling accounts is Super Admin only: 403; edit still allowed', b.status === 403 && c.status === 403 && d.status === 200, `${b.status},${c.status},${d.status}`)
  await call(SA, 'PUT', `/access/users/${adminId}`, { modules: { workers: null } })
}

// ---- 9. Shift Sign-In permissions
{
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { shift_signin: off } })
  const a = await call(MGR2, 'GET', '/users/shift-status')
  const b = await call(MGR2, 'GET', '/shifts/login-settings')
  check('9a no Shift Sign-In: status and settings refused', a.status === 403 && b.status === 403)
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { shift_signin: { view: true } } })
  const c = await call(MGR2, 'GET', '/users/shift-status')
  const s = await call(MGR2, 'GET', '/shifts/login-settings')
  const d = await call(MGR2, 'PUT', '/shifts/login-settings', s.json)
  check('9b view only: status and settings readable, change refused', c.status === 200 && s.status === 200 && d.status === 403, `${c.status},${s.status},${d.status}`)
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { shift_signin: { view: true, edit: true } } })
  const e = await call(MGR2, 'PUT', '/shifts/login-settings', s.json)
  check('9c edit: settings saved and audited', e.status === 200 && !!(await lastAudit('UPDATE_SHIFT_LOGIN_SETTINGS')))
  const g = await call(MGR2, 'GET', '/shifts')
  check('9d the Shifts list still follows Shifts (not Shift Sign-In)', g.status === 200)
}

// ---- 10. Company Wi-Fi permissions
{
  const rule = await call(ADMIN, 'GET', '/shifts/wifi-rule')
  const a = await call(ADMIN, 'PUT', '/shifts/wifi-rule', rule.json)
  check('10a Admin sees the Wi-Fi rule but cannot change it by default', rule.status === 200 && a.status === 403)
  await call(SA, 'PUT', `/access/users/${adminId}`, { modules: { wifi_rule: { view: true, edit: true } } })
  const b = await call(ADMIN, 'PUT', '/shifts/wifi-rule', rule.json)
  check('10b Super Admin grants this Admin Wi-Fi edit: saved and audited', b.status === 200 && !!(await lastAudit('UPDATE_WIFI_ALERT_RULE')))
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { wifi_rule: off } })
  const c = await call(MGR2, 'GET', '/shifts/wifi-rule')
  check('10c Manager without Company Wi-Fi: rule hidden', c.status === 403)
}

// ---- 11. Permanent deletes follow the matrix; Delete Users stays the Super Admin's
{
  const a = await call(ADMIN, 'GET', '/deletions/permissions')
  check('11a Admin: no Delete Jobs/Checks/Users by default', a.json.permissions.DELETE_JOBS === false && a.json.permissions.DELETE_CHECKS === false && a.json.permissions.DELETE_USERS === false)
  await call(SA, 'PUT', `/access/users/${adminId}`, { modules: { jobs: full } })
  const b = await call(ADMIN, 'GET', '/deletions/permissions')
  const c = await call(ADMIN, 'POST', '/deletions/users/impact', { ids: [workerId] })
  check('11b Jobs delete granted to this Admin: Delete Jobs on, Delete Users still refused', b.json.permissions.DELETE_JOBS === true && c.status === 403)
  const legacy = await call(SA, 'PUT', `/access/admins/${adminId}/delete-permissions`, { permissions: { DELETE_CHECKS: true } })
  const d = await call(ADMIN, 'GET', '/deletions/permissions')
  check('11c older app screen (Admin delete permissions) still works through the matrix', legacy.status === 200 && d.json.permissions.DELETE_CHECKS === true)
}

// ---- 10x. Existing sign-in still works, and follows the account's current role
{
  const empId = (await db.select().from(users).where(eq(users.id, adminId)))[0].employeeId
  const login = async (password: string) => {
    const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: empId, password, app: 'admin' }) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  const bad = await login('wrong-password')
  const ok = await login('secret12')
  const me = ok.json?.accessToken ? await call(ok.json.accessToken, 'GET', '/auth/me') : { status: 0, json: null }
  check('10x sign-in: wrong password refused, right password signs in with the Admin role and its permissions', bad.status === 401 && ok.status === 200 && me.json?.role === 'ADMIN' && me.json?.actions?.wifi_rule?.edit === true, `${bad.status},${ok.status}`)
  const edit = await call(SA, 'PUT', `/users/${adminId}`, { name: 'Test ADMIN A (renamed)' })
  const still = await call(ok.json.accessToken, 'GET', '/auth/me')
  check('10y editing an account (no role change) keeps the person signed in', edit.status === 200 && still.status === 200)
}

// ---- 12. Scores follow the matrix; legacy Manager screen
{
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { performance: { view: true } } })
  const a = await call(MGR2, 'GET', '/performance/weekly')
  const b = await call(MGR2, 'GET', '/performance/overall')
  await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { performance: off } })
  const c = await call(MGR2, 'GET', '/performance/overall')
  check('12a Weekly and Overall scores: allowed with Worker Performance view, refused without', a.status === 200 && b.status === 200 && c.status === 403, `${a.status},${b.status},${c.status}`)
  const l = await call(SA, 'GET', '/access/roles/manager')
  const p = await call(SA, 'PUT', '/access/roles/manager', { permissions: { performance: 'view' } })
  check('12b older app Manager screen: read and save still work', l.status === 200 && p.status === 200 && p.json.permissions.performance === 'view')
  const all = await db.select().from(auditLogs).where(inArray(auditLogs.action, ['CHANGE_ROLE', 'UPDATE_ROLE_PERMISSIONS', 'UPDATE_USER_PERMISSIONS', 'GRANT_DELETE_PERMISSION']))
  check('12c audit log holds role and permission changes', all.length >= 10, `${all.length} entries`)
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
