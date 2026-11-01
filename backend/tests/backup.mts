/**
 * Backup & Restore (npm run test:backup). Refuses to run unless DATABASE_URL names a database ending
 * in "_test". The server under test (PORT=4191) and this script must share these settings, each a
 * folder used only by the test: UPLOAD_DIR, REPORT_OUTBOX_DIR, CALENDAR_DOCS_DIR, BACKUP_DIR,
 * BACKUP_STATE_FILE, BACKUP_WORK_DIR.
 *
 * Covers: Super Admin only (API level); a backup and what is in it; the one-time download link;
 * damaged and foreign files refused; Skip / Replace / Full restore against data changed after the
 * backup; the API paused during a restore; cancelling; one job at a time; the backup folder setting;
 * audit log entries.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import yauzl from 'yauzl'
import archiver from 'archiver'
import { db, pool } from '../src/db/client'
import { auditLogs, departments, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
for (const v of ['UPLOAD_DIR', 'REPORT_OUTBOX_DIR', 'CALENDAR_DOCS_DIR', 'BACKUP_DIR', 'BACKUP_STATE_FILE', 'BACKUP_WORK_DIR']) {
  if (!process.env[v]) {
    console.error(`Refusing to run: set ${v} to a test folder.`)
    process.exit(2)
  }
}
const UPLOADS = path.resolve(process.env.UPLOAD_DIR!)
const OUTBOX = path.resolve(process.env.REPORT_OUTBOX_DIR!)
const CALDOCS = path.resolve(process.env.CALENDAR_DOCS_DIR!)
const BACKUPS = path.resolve(process.env.BACKUP_DIR!)
const ROOT = `${process.env.RBAC_API ?? 'http://localhost:4191'}`
const BASE = `${ROOT}/api`

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
const call = async (token: string | null, method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
/** Polls a job until it stops running; also probes the API meanwhile (to see the 503 pause). */
const waitJob = async (id: string, probe?: { token: string; seen503: boolean }) => {
  for (let i = 0; i < 600; i++) {
    const r = await fetch(`${BASE}/backup-jobs/${id}`)
    const job = (await r.json()) as any
    if (probe && job.status === 'running') {
      const p = await call(probe.token, 'GET', '/departments')
      if (p.status === 503) probe.seen503 = true
    }
    if (job.status !== 'running') return job
    await sleep(300)
  }
  throw new Error('job did not finish')
}
const zipNames = (file: string) =>
  new Promise<string[]>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: false }, (err, z) => {
      if (err || !z) return reject(err)
      const names: string[] = []
      z.on('entry', (e: yauzl.Entry) => names.push(e.fileName))
      z.on('end', () => resolve(names))
      z.on('error', reject)
    })
  )

for (const d of [UPLOADS, OUTBOX, CALDOCS, BACKUPS]) fs.rmSync(d, { recursive: true, force: true })

// ---- Users
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const SA = await tokenFor(sa.id)
const stamp = Date.now() % 100000
const mk = async (role: string) => {
  const r = await call(SA, 'POST', '/users', { password: 'secret12', employeeId: `BK${role[0]}${stamp}`, name: `Backup test ${role}`, role, ...(role === 'MANAGER' || role === 'WORKER' ? { workerQualityRole: 'QC' } : {}) })
  if (r.status !== 201) throw new Error(`create ${role}: ${r.status} ${JSON.stringify(r.json)}`)
  return tokenFor(r.json.id)
}
const ADMIN = await mk('ADMIN')
const MANAGER = await mk('MANAGER')

// ---- 1. Super Admin only, at the API
for (const [who, token, expect] of [['Admin', ADMIN, 403], ['Manager', MANAGER, 403], ['no sign-in', null, 401]] as const) {
  const r1 = await call(token, 'GET', '/system/backup/overview')
  const r2 = await call(token, 'POST', '/system/backup/backups')
  const r3 = await call(token, 'POST', '/system/backup/restore/analyse', { file: 'x.zip' })
  check(`1 ${who} cannot use Backup & Restore`, r1.status === expect && r2.status === expect && r3.status === expect, `${r1.status} ${r2.status} ${r3.status}`)
}
const ov0 = await call(SA, 'GET', '/system/backup/overview')
check('1 Super Admin sees the overview; tools found', ov0.status === 200 && ov0.json.tools.ok === true, JSON.stringify(ov0.json?.tools))
check('1 default folder is BACKUP_DIR', path.resolve(ov0.json.location) === BACKUPS, ov0.json.location)

// ---- 2. Files to back up
const photo = path.join(UPLOADS, 'quality-checks', '2026-10-30', 'a.jpg')
write(photo, 'original photo')
write(path.join(UPLOADS, 'exceptions', 'b.mp4'), 'a video')
write(path.join(UPLOADS, '.tmp', 'partial-upload'), 'not backed up')
write(path.join(CALDOCS, 'doc.pdf'), 'calendar doc')
write(path.join(OUTBOX, 'm.eml'), 'an email')

// ---- 3. Backup
const start = await call(SA, 'POST', '/system/backup/backups')
const again = await call(SA, 'POST', '/system/backup/backups')
check('3 a second backup while one runs is refused', again.status === 409, String(again.status))
const done = await waitJob(start.json.id)
check('3 backup succeeds', done.status === 'success', done.error ?? '')
const zip = path.join(BACKUPS, done.file)
check('3 file name Data_Backup_<date>_<time>.zip (no kind chosen: database + files)', /^Data_Backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(_\d+)?\.zip$/.test(done.file), done.file)
check('3 no .partial file left', !fs.readdirSync(BACKUPS).some((n) => n.endsWith('.partial')))
const names = await zipNames(zip)
check(
  '3 zip has manifest, database and every file (not .tmp)',
  names.includes('manifest.json') &&
    names.includes('database.dump') &&
    ['files/uploads/quality-checks/2026-10-30/a.jpg', 'files/uploads/exceptions/b.mp4', 'files/calendar-documents/doc.pdf', 'files/report-outbox/m.eml'].every((n) => names.includes(n)) &&
    !names.some((n) => n.includes('.tmp')),
  names.join(', ')
)
const ov1 = await call(SA, 'GET', '/system/backup/overview')
check('3 overview: last backup, listed and valid', ov1.json.lastBackup?.file === done.file && ov1.json.backups.some((b: any) => b.name === done.file && b.valid), JSON.stringify(ov1.json.lastBackup))
check('3 the manifest has no password', !fs.readFileSync(zip).includes(Buffer.from(decodeURIComponent(new URL(process.env.DATABASE_URL!).password))))

// ---- 4. Download link: works once
const link = await call(SA, 'POST', `/system/backup/backups/${encodeURIComponent(done.file)}/download-link`)
const dl = await fetch(ROOT + link.json.url)
const body = Buffer.from(await dl.arrayBuffer())
check('4 download link gives the file', dl.status === 200 && body.length === fs.statSync(zip).size, `${dl.status} ${body.length}`)
check('4 the link works only once', (await fetch(ROOT + link.json.url)).status === 404)
const outside = await call(SA, 'POST', `/system/backup/backups/${encodeURIComponent('..\\..\\package.json')}/download-link`)
check('4 only backup files can be downloaded', outside.status === 404, String(outside.status))

// ---- 5. Damaged and foreign files are refused before anything changes
const bytes = fs.readFileSync(zip)
const at = bytes.indexOf(Buffer.from('original photo'))
const bad = Buffer.from(bytes)
bad[at] = bad[at] ^ 0xff
fs.writeFileSync(path.join(BACKUPS, 'Damaged.zip'), bad)
const dmg = await waitJob((await call(SA, 'POST', '/system/backup/restore/analyse', { file: 'Damaged.zip' })).json.id)
check('5 a damaged backup is refused', dmg.status === 'failed' && /damaged|checksum|crc/i.test(dmg.error), dmg.error)
await new Promise<void>((resolve, reject) => {
  const out = fs.createWriteStream(path.join(BACKUPS, 'Foreign.zip'))
  const a = archiver('zip')
  a.on('error', reject)
  out.on('close', () => resolve())
  a.pipe(out)
  a.append('hello', { name: 'readme.txt' })
  void a.finalize()
})
const form = new FormData()
form.append('file', new Blob([fs.readFileSync(path.join(BACKUPS, 'Foreign.zip'))]), 'Foreign.zip')
const up = await fetch(`${BASE}/system/backup/restore/upload`, { method: 'POST', headers: { Authorization: `Bearer ${SA}` }, body: form })
const foreign = await waitJob(((await up.json()) as any).id)
check('5 a zip not made by this module is refused (uploaded)', foreign.status === 'failed' && /not made by/i.test(foreign.error), foreign.error)
fs.rmSync(path.join(BACKUPS, 'Damaged.zip'))
fs.rmSync(path.join(BACKUPS, 'Foreign.zip'))

// ---- 6. Change the data after the backup
const [someUser] = await db.select().from(users).where(eq(users.id, sa.id))
const originalName = someUser.name
await db.update(users).set({ name: `${originalName} (renamed)` }).where(eq(users.id, sa.id))
const [anAudit] = await db.select().from(auditLogs).limit(1)
await db.delete(auditLogs).where(eq(auditLogs.id, anAudit.id))
const [newDept] = await db.insert(departments).values({ name: `After Backup ${stamp}`, code: `AB${stamp}` }).returning()
write(photo, 'changed photo')
fs.rmSync(path.join(CALDOCS, 'doc.pdf'))
write(path.join(UPLOADS, 'quality-checks', 'new.jpg'), 'added after backup')

const analyse = async () => {
  const started = await call(SA, 'POST', '/system/backup/restore/analyse', { file: done.file })
  if (started.status !== 202) throw new Error(`analyse start: ${started.status} ${JSON.stringify(started.json)}`)
  const j = await waitJob(started.json.id)
  if (j.status !== 'awaiting-choice') throw new Error(`analyse: ${j.status} ${j.error}`)
  return j
}

// ---- 7. Analysis
const a1 = await analyse()
const t = (name: string) => a1.analysis.tables.find((x: any) => x.table === name)
const f = (key: string) => a1.analysis.files.find((x: any) => x.key === key)
check('7 duplicates found', a1.analysis.duplicates === true)
check('7 renamed user counted as different', t('users').different >= 1, JSON.stringify(t('users')))
check('7 deleted audit entry counted as new', t('audit_logs').newRows >= 1, JSON.stringify(t('audit_logs')))
check('7 files: changed, missing and extra found', f('uploads').different === 1 && f('uploads').liveOnly === 1 && f('calendar-documents').newFiles === 1, JSON.stringify(a1.analysis.files))
const busy = await call(SA, 'POST', '/system/backup/backups')
check('7 nothing else runs while a restore waits for a choice', busy.status === 409, String(busy.status))

// Cancel: nothing changes, the temporary database goes.
const cancelled = await call(SA, 'POST', `/system/backup/restore/${a1.id}/cancel`)
check('7 cancel accepted', cancelled.status === 200 && cancelled.json.cancelled === true, JSON.stringify(cancelled))
const stageLeft = await pool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [`${dbName}_restore_stage`])
check('7 cancel removes the temporary database', stageLeft.rowCount === 0)
check('7 cancel changed nothing', (await db.select().from(users).where(eq(users.id, sa.id)))[0].name === `${originalName} (renamed)`)

// ---- 8. Skip duplicates
const a2 = await analyse()
const probe = { token: SA, seen503: false }
await call(SA, 'POST', `/system/backup/restore/${a2.id}/apply`, { mode: 'SKIP' })
const r2 = await waitJob(a2.id, probe)
check('8 skip restore succeeds', r2.status === 'success', r2.error ?? '')
check('8 the API is paused (503) during the restore', probe.seen503)
check('8 a safety backup was made first', !!r2.result?.safetyBackup && fs.existsSync(path.join(BACKUPS, r2.result.safetyBackup)), r2.result?.safetyBackup)
check('8 deleted record is back', (await db.select().from(auditLogs).where(eq(auditLogs.id, anAudit.id))).length === 1)
check('8 existing record kept as it is', (await db.select().from(users).where(eq(users.id, sa.id)))[0].name === `${originalName} (renamed)`)
check('8 newer record kept', (await db.select().from(departments).where(eq(departments.id, newDept.id))).length === 1)
check('8 missing file back, changed file kept, extra file kept', fs.existsSync(path.join(CALDOCS, 'doc.pdf')) && fs.readFileSync(photo, 'utf8') === 'changed photo' && fs.existsSync(path.join(UPLOADS, 'quality-checks', 'new.jpg')))

// ---- 9. Replace existing
fs.rmSync(path.join(CALDOCS, 'doc.pdf'))
const a3 = await analyse()
await call(SA, 'POST', `/system/backup/restore/${a3.id}/apply`, { mode: 'REPLACE' })
const r3 = await waitJob(a3.id)
check('9 replace restore succeeds', r3.status === 'success', r3.error ?? '')
check('9 existing record replaced by the backup', (await db.select().from(users).where(eq(users.id, sa.id)))[0].name === originalName)
check('9 newer record kept', (await db.select().from(departments).where(eq(departments.id, newDept.id))).length === 1)
check('9 changed file replaced, extra file kept', fs.readFileSync(photo, 'utf8') === 'original photo' && fs.existsSync(path.join(UPLOADS, 'quality-checks', 'new.jpg')) && fs.existsSync(path.join(CALDOCS, 'doc.pdf')))
const usersRow = r3.result?.tables?.find((x: any) => x.table === 'users')
check('9 result counts the replaced record', usersRow?.updated >= 1, JSON.stringify(usersRow))

// ---- 10. Full restore
await db.update(users).set({ name: `${originalName} (renamed)` }).where(eq(users.id, sa.id))
write(photo, 'changed again')
const a4 = await analyse()
const noConfirm = await call(SA, 'POST', `/system/backup/restore/${a4.id}/apply`, { mode: 'FULL' })
check('10 full restore needs RESTORE typed', noConfirm.status === 400, String(noConfirm.status))
await call(SA, 'POST', `/system/backup/restore/${a4.id}/apply`, { mode: 'FULL', confirm: 'RESTORE' })
const r4 = await waitJob(a4.id)
check('10 full restore succeeds', r4.status === 'success', r4.error ?? '')
check('10 records made after the backup are gone', (await db.select().from(departments).where(eq(departments.id, newDept.id))).length === 0)
check('10 changed record back to the backup', (await db.select().from(users).where(eq(users.id, sa.id)))[0].name === originalName)
const manifestCounts = a4.analysis.tables.filter((x: any) => ['users', 'quality_checks', 'departments', 'media'].includes(x.table))
let countsOk = true
for (const m of manifestCounts) {
  const n = Number((await pool.query(`SELECT count(*) AS n FROM "${m.table}"`)).rows[0].n)
  if (n !== m.backupRows) countsOk = false
}
check('10 table row counts match the backup', countsOk, JSON.stringify(manifestCounts.map((m: any) => [m.table, m.backupRows])))
check('10 files exactly the backup (extra file gone, upload temp folder kept)', fs.readFileSync(photo, 'utf8') === 'original photo' && !fs.existsSync(path.join(UPLOADS, 'quality-checks', 'new.jpg')) && fs.existsSync(path.join(UPLOADS, '.tmp', 'partial-upload')))
const fk = await pool.query(`SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f'`)
check('10 relationships (foreign keys) restored', Number(fk.rows[0].n) > 50, fk.rows[0].n)
const mig = await pool.query(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)
check('10 migration history restored', Number(mig.rows[0].n) > 40, mig.rows[0].n)
const health = await call(SA, 'GET', '/departments')
check('10 the API works after the full restore', health.status === 200, String(health.status))

// ---- 11. History and audit
const ov2 = await call(SA, 'GET', '/system/backup/overview')
const kinds = ov2.json.history.map((h: any) => `${h.kind}:${h.status}`)
check('11 history: backups, safety backups and restores', kinds.filter((k: string) => k === 'RESTORE:SUCCESS').length === 3 && kinds.includes('SAFETY_BACKUP:SUCCESS') && kinds.includes('BACKUP:SUCCESS'), kinds.join(','))
await sleep(500)
const audits = await db.select({ action: auditLogs.action }).from(auditLogs).where(sql`${auditLogs.entity} = 'Backup'`)
check('11 audit log has the full restore', audits.some((a) => a.action === 'BACKUP_RESTORE'), audits.map((a) => a.action).join(','))

// ---- 12. Backup folder setting
const rel = await call(SA, 'PUT', '/system/backup/location', { path: 'relative\\folder' })
check('12 a relative folder is refused', rel.status === 400, rel.json?.error)
const inUploads = await call(SA, 'PUT', '/system/backup/location', { path: path.join(UPLOADS, 'x') })
check('12 a folder inside uploads is refused', inUploads.status === 400, inUploads.json?.error)
const other = path.join(BACKUPS, '..', `other-backups-${crypto.randomUUID().slice(0, 6)}`)
const set = await call(SA, 'PUT', '/system/backup/location', { path: other })
const b2 = await waitJob((await call(SA, 'POST', '/system/backup/backups')).json.id)
check('12 backups go to the chosen folder', set.status === 200 && b2.status === 'success' && fs.existsSync(path.join(other, b2.file)), `${set.status} ${b2.error ?? ''}`)
const reset = await call(SA, 'PUT', '/system/backup/location', { path: null })
check('12 blank resets to the default folder', path.resolve(reset.json.location) === BACKUPS)
fs.rmSync(other, { recursive: true, force: true })

for (const r of results) console.log(r)
console.log(`\n${passed} passed, ${failed} failed`)
await pool.end()
process.exit(failed ? 1 : 0)
