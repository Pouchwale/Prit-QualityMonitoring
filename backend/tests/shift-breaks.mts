/**
 * Breaks belong to shifts (npm run test:shift-breaks). Refuses to run unless DATABASE_URL names a
 * database ending in "_test"; needs a server on it (PORT=4191, RBAC_API to change).
 *
 * Covers: the workers' breaks moved onto their shifts (migration 0048); a new shift must say its
 * break (or "No break"); the break must lie inside the shift's hours, also when the hours change;
 * an edit without break fields (older app) keeps the break; the same for Super Admin, Admin and a
 * Manager allowed to manage shifts, and refused without that permission; every worker has the break
 * of their shift, and a worker moved to another shift takes that shift's break at once.
 */
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { shifts, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { loadBreaks } from '../src/services/workerBreaks'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`
let passed = 0
let failed = 0
const results: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const tokenFor = async (id: string) => {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, 'web').accessToken
}
const call = async (token: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const SA = await tokenFor(sa.id)
const stamp = Date.now() % 100000
const mk = async (role: string, extra: Record<string, unknown> = {}) => {
  const r = await call(SA, 'POST', '/users', { password: 'secret12', employeeId: `SB${role[0]}${stamp}`, name: `Shift break ${role}`, role, ...extra })
  if (r.status !== 201) throw new Error(`create ${role}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json.id as string
}

// ---- 1. Migration: each shift has its workers' break
const all = await db.select().from(shifts)
const A = all.find((s) => s.code === 'SHIFT-A')!
const B = all.find((s) => s.code === 'SHIFT-B')!
check('1 Shift A has its workers\' break 12:30–13:00', A.breakStartTime === '12:30' && A.breakEndTime === '13:00', `${A.breakStartTime}-${A.breakEndTime}`)
check('1 Shift B has its workers\' break 00:30–01:00', B.breakStartTime === '00:30' && B.breakEndTime === '01:00', `${B.breakStartTime}-${B.breakEndTime}`)
const unused = all.filter((s) => s.code !== 'SHIFT-A' && s.code !== 'SHIFT-B')
check('1 shifts without workers have no break', unused.every((s) => s.breakStartTime === null && s.breakEndTime === null))

// ---- 2. Creating a shift asks for its break
const base = (code: string) => ({ name: `Test ${code}`, code: `${code}${stamp}`, startTime: '06:00', endTime: '14:00', graceMinutes: 15, isActive: true })
const noBreakKeys = await call(SA, 'POST', '/shifts', base('NB'))
check('2 a new shift without its break is refused', noBreakKeys.status === 400 && /break/i.test(noBreakKeys.json?.error ?? ''), noBreakKeys.json?.error)
const outside = await call(SA, 'POST', '/shifts', { ...base('OUT'), breakStartTime: '15:00', breakEndTime: '15:30' })
check('2 a break outside the shift is refused', outside.status === 400 && /inside the shift/i.test(outside.json?.error ?? ''), outside.json?.error)
const tooLong = await call(SA, 'POST', '/shifts', { ...base('LONG'), breakStartTime: '07:00', breakEndTime: '11:30' })
check('2 a break over 4 hours is refused', tooLong.status === 400, tooLong.json?.error)
const half = await call(SA, 'POST', '/shifts', { ...base('HALF'), breakStartTime: '10:00', breakEndTime: null })
check('2 only half a break is refused', half.status === 400, half.json?.error)
const none = await call(SA, 'POST', '/shifts', { ...base('NONE'), breakStartTime: null, breakEndTime: null })
check('2 "No break" chosen on purpose is saved', none.status === 201 && none.json.breakStartTime === null, String(none.status))
const day = await call(SA, 'POST', '/shifts', { ...base('DAY'), breakStartTime: '10:00', breakEndTime: '10:30' })
check('2 a shift with its break is created', day.status === 201 && day.json.breakStartTime === '10:00' && day.json.breakEndTime === '10:30', JSON.stringify(day.json))
const night = await call(SA, 'POST', '/shifts', { ...base('NIGHT'), startTime: '22:00', endTime: '06:00', breakStartTime: '02:00', breakEndTime: '02:45' })
check('2 an overnight shift with a break after midnight is created', night.status === 201, night.json?.error)
const nightOut = await call(SA, 'POST', '/shifts', { ...base('NOUT'), startTime: '22:00', endTime: '06:00', breakStartTime: '05:45', breakEndTime: '06:15' })
check('2 an overnight break running past the shift end is refused', nightOut.status === 400, nightOut.json?.error)

// ---- 3. Editing keeps hours and break together
const DAY = day.json.id as string
const keep = await call(SA, 'PUT', `/shifts/${DAY}`, { ...base('DAY'), name: 'Renamed day' })
check('3 an edit without break fields (older app) keeps the break', keep.status === 200 && keep.json.breakStartTime === '10:00' && keep.json.breakEndTime === '10:30', JSON.stringify(keep.json))
const moveHours = await call(SA, 'PUT', `/shifts/${DAY}`, { ...base('DAY'), startTime: '11:00', endTime: '19:00' })
check('3 new hours that leave the break outside are refused', moveHours.status === 400 && /inside the shift/i.test(moveHours.json?.error ?? ''), moveHours.json?.error)
const both = await call(SA, 'PUT', `/shifts/${DAY}`, { ...base('DAY'), startTime: '11:00', endTime: '19:00', breakStartTime: '15:00', breakEndTime: '15:20' })
check('3 hours and break changed together are saved', both.status === 200 && both.json.startTime === '11:00' && both.json.breakStartTime === '15:00', JSON.stringify(both.json))
const clear = await call(SA, 'PUT', `/shifts/${DAY}`, { ...base('DAY'), startTime: '11:00', endTime: '19:00', breakStartTime: null, breakEndTime: null })
check('3 the break can be changed to "No break"', clear.status === 200 && clear.json.breakStartTime === null)
await call(SA, 'PUT', `/shifts/${DAY}`, { ...base('DAY'), startTime: '11:00', endTime: '19:00', breakStartTime: '15:00', breakEndTime: '15:20' })

// ---- 4. Everyone allowed to manage shifts, and nobody else
const admin = await tokenFor(await mk('ADMIN'))
const byAdmin = await call(admin, 'POST', '/shifts', { ...base('ADM'), breakStartTime: '09:00', breakEndTime: '09:15' })
check('4 an Admin creates a shift with its break', byAdmin.status === 201 && byAdmin.json.breakStartTime === '09:00', `${byAdmin.status} ${byAdmin.json?.error ?? ''}`)
const manager = await tokenFor(await mk('MANAGER', { workerQualityRole: 'QC' }))
await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { shifts: { view: true, create: false, edit: false, delete: false } } })
const denied = await call(manager, 'POST', '/shifts', { ...base('MGR'), breakStartTime: '09:00', breakEndTime: '09:15' })
check('4 a Manager without shift permission cannot create shifts', denied.status === 403, String(denied.status))
await call(SA, 'PUT', '/access/roles/MANAGER', { modules: { shifts: { view: true, create: true, edit: true, delete: false } } })
const byManager = await call(manager, 'POST', '/shifts', { ...base('MGR'), breakStartTime: '09:00', breakEndTime: '09:15' })
check('4 a Manager allowed to manage shifts creates one with its break', byManager.status === 201 && byManager.json.breakEndTime === '09:15', `${byManager.status} ${byManager.json?.error ?? ''}`)
const mgrEdit = await call(manager, 'PUT', `/shifts/${byManager.json.id}`, { ...base('MGR'), breakStartTime: '10:00', breakEndTime: '10:30' })
check('4 that Manager changes the break', mgrEdit.status === 200 && mgrEdit.json.breakStartTime === '10:00', `${mgrEdit.status} ${mgrEdit.json?.error ?? ''}`)
const mgrNoBreak = await call(manager, 'POST', '/shifts', base('MGR2'))
check('4 the Manager is asked for the break too', mgrNoBreak.status === 400, String(mgrNoBreak.status))

// ---- 5. Workers have their shift's break; moving shifts moves the break
const workerId = await mk('WORKER', { workerQualityRole: 'QC', shiftId: A.id })
let breaks = await loadBreaks()
check('5 a worker on Shift A has Shift A\'s break', breaks.get(workerId)?.startTime === '12:30' && breaks.get(workerId)?.endTime === '13:00', JSON.stringify(breaks.get(workerId)))
const list1 = await call(SA, 'GET', '/shifts/breaks')
const row1 = list1.json.find((r: any) => r.workerId === workerId)
check('5 the break list shows it, from the shift', row1?.shiftName === A.name && row1?.startTime === '12:30' && row1?.durationMinutes === 30, JSON.stringify(row1))
const [w] = await db.select().from(users).where(eq(users.id, workerId))
const move = await call(SA, 'PUT', `/users/${workerId}`, { employeeId: w.employeeId, name: w.name, role: 'WORKER', workerQualityRole: 'QC', shiftId: B.id })
check('5 the worker is moved to Shift B', move.status === 200, `${move.status} ${move.json?.error ?? ''}`)
breaks = await loadBreaks()
check('5 the worker now has Shift B\'s break, with nothing else to set', breaks.get(workerId)?.startTime === '00:30' && breaks.get(workerId)?.endTime === '01:00', JSON.stringify(breaks.get(workerId)))
const row2 = (await call(SA, 'GET', '/shifts/breaks')).json.find((r: any) => r.workerId === workerId)
check('5 the break list follows the move', row2?.shiftName === B.name && row2?.startTime === '00:30', JSON.stringify(row2))
await call(SA, 'PUT', `/shifts/${B.id}`, { name: B.name, code: B.code, startTime: B.startTime, endTime: B.endTime, graceMinutes: B.graceMinutes, isActive: true, breakStartTime: '02:00', breakEndTime: '02:40' })
breaks = await loadBreaks()
check('5 changing the shift\'s break changes it for its workers', breaks.get(workerId)?.startTime === '02:00' && breaks.get(workerId)?.endTime === '02:40', JSON.stringify(breaks.get(workerId)))
await call(SA, 'PUT', `/users/${workerId}`, { employeeId: w.employeeId, name: w.name, role: 'WORKER', workerQualityRole: 'QC', shiftId: none.json.id })
breaks = await loadBreaks()
check('5 a worker moved to a shift without a break has none', !breaks.has(workerId))
const gone = await call(SA, 'PUT', '/shifts/breaks/' + workerId, { startTime: '10:00', endTime: '10:30' })
check('5 breaks can no longer be set per worker', gone.status === 404 || gone.status === 400, String(gone.status))

for (const r of results) console.log(r)
console.log(`\n${passed} passed, ${failed} failed`)
await pool.end()
process.exit(failed ? 1 : 0)
