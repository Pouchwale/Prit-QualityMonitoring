/**
 * Full project and Database only backups (npm run test:backup-scopes). Refuses to run unless
 * DATABASE_URL names a database ending in "_test". The server under test (PORT=4191) and this script
 * share PROJECT_DIR (a fake project folder made here), UPLOAD_DIR, REPORT_OUTBOX_DIR and
 * CALENDAR_DOCS_DIR (inside it), BACKUP_DIR (its "Database Backup" folder), BACKUP_STATE_FILE and
 * BACKUP_WORK_DIR, all folders used only by the test.
 *
 * Covers: what a Full project backup holds and leaves out (.git, node_modules unless chosen, key
 * files when not chosen, earlier backups, itself, the upload folders twice); RESTORE.txt; the
 * estimate; a Database only backup holds the database only; restoring a Database only backup
 * (even "everything") leaves the files alone; a Full project backup restores its data.
 */
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import yauzl from 'yauzl'
import { db, pool } from '../src/db/client'
import { departments, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
for (const v of ['PROJECT_DIR', 'UPLOAD_DIR', 'REPORT_OUTBOX_DIR', 'CALENDAR_DOCS_DIR', 'BACKUP_DIR', 'BACKUP_STATE_FILE', 'BACKUP_WORK_DIR']) {
  if (!process.env[v]) {
    console.error(`Refusing to run: set ${v} to a test folder.`)
    process.exit(2)
  }
}
const PROJECT = path.resolve(process.env.PROJECT_DIR!)
const UPLOADS = path.resolve(process.env.UPLOAD_DIR!)
const BACKUPS = path.resolve(process.env.BACKUP_DIR!)
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`

let passed = 0
let failed = 0
const results: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const write = (rel: string, text: string, root = PROJECT) => {
  const f = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}
const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
const SA = signTokens(sa, 'web').accessToken
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${SA}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitJob = async (id: string) => {
  for (let i = 0; i < 600; i++) {
    const job = (await (await fetch(`${BASE}/backup-jobs/${id}`)).json()) as any
    if (job.status !== 'running') return job
    await sleep(300)
  }
  throw new Error('job did not finish')
}
const backup = async (body: unknown) => waitJob((await call('POST', '/system/backup/backups', body)).json.id)
const zipEntries = (file: string) =>
  new Promise<{ names: string[]; read: (n: string) => Promise<string> }>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: false, autoClose: false }, (err, z) => {
      if (err || !z) return reject(err)
      const entries = new Map<string, yauzl.Entry>()
      z.on('entry', (e: yauzl.Entry) => entries.set(e.fileName, e))
      z.on('end', () =>
        resolve({
          names: [...entries.keys()],
          read: (n) =>
            new Promise((res, rej) =>
              z.openReadStream(entries.get(n)!, async (e2, s) => {
                if (e2 || !s) return rej(e2)
                const chunks: Buffer[] = []
                for await (const c of s) chunks.push(c as Buffer)
                res(Buffer.concat(chunks).toString('utf8'))
              })
            )
        })
      )
      z.on('error', reject)
    })
  )

// ---- A small project folder, with the backup folder and the upload folders inside it
fs.rmSync(PROJECT, { recursive: true, force: true })
write('README.md', 'readme')
write('server.bat', '@echo off')
write('admin-web/src/App.tsx', 'export {}')
write('admin-web/node_modules/pkg/index.js', 'module.exports = 1')
write('backend/src/index.ts', 'console.log(1)')
write('backend/.env', 'DATABASE_URL=postgres://u:secret@x/db')
write('backend/.env.example', 'DATABASE_URL=')
write('backend/secrets/password-view.key', 'KEY')
write('builds/app.apk', 'apk')
write('.git/HEAD', 'ref: refs/heads/main')
write('Database Backup/notes.txt', 'kept')
write('Database Backup/Full_Project_Backup_2020-01-01_00-00.zip', 'an older backup')
write('quality-checks/a.jpg', 'photo A', UPLOADS)

// ---- 1. The estimate shown before starting
const est = await call('GET', '/system/backup/estimate?scope=PROJECT')
check('1 estimate: project files without .git, node_modules and earlier backups', est.status === 200 && est.json.project.count === 9 && est.json.project.skippedBackups === 1, JSON.stringify(est.json?.project))
const estPkg = await call('GET', '/system/backup/estimate?scope=PROJECT&packages=1&secrets=0')
check('1 estimate follows the options', estPkg.json.project.count === 8, JSON.stringify(estPkg.json?.project))
const estDb = await call('GET', '/system/backup/estimate?scope=DATABASE')
check('1 estimate: database only has no files', estDb.json.project === null && estDb.json.files.count === 0 && estDb.json.databaseBytes > 0)

// ---- 2. Full project backup
const p1 = await backup({ scope: 'PROJECT' })
check('2 full project backup succeeds', p1.status === 'success', p1.error ?? '')
check('2 named Full_Project_Backup_<date>_<time>.zip', /^Full_Project_Backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(_\d+)?\.zip$/.test(p1.file), p1.file)
const z1 = await zipEntries(path.join(BACKUPS, p1.file))
const has = (n: string) => z1.names.includes(n)
check(
  '2 holds the project: code, apps, settings, builds, scripts',
  ['project/README.md', 'project/server.bat', 'project/admin-web/src/App.tsx', 'project/backend/src/index.ts', 'project/builds/app.apk', 'project/Database Backup/notes.txt', 'project/backend/.env.example'].every(has)
)
check('2 holds the database, the photos and RESTORE.txt', has('database.dump') && has('files/uploads/quality-checks/a.jpg') && has('RESTORE.txt') && has('manifest.json'))
check('2 settings and keys included by default', has('project/backend/.env') && has('project/backend/secrets/password-view.key'))
check('2 leaves out .git and node_modules', !z1.names.some((n) => n.includes('/.git/') || n.includes('node_modules')))
check('2 leaves out earlier backups and itself', !z1.names.some((n) => /\.zip(\.partial)?$/.test(n)))
check('2 the photos are not in it twice', !z1.names.some((n) => n.startsWith('project/') && n.includes('quality-checks/a.jpg')))
const manifest = JSON.parse(await z1.read('manifest.json'))
check('2 manifest: scope PROJECT, project counted, every entry has a checksum', manifest.scope === 'PROJECT' && manifest.project.count === 9 && z1.names.filter((n) => n !== 'manifest.json').every((n) => manifest.checksums[n]), JSON.stringify(manifest.project))
const guide = await z1.read('RESTORE.txt')
check('2 RESTORE.txt says how to set it up and warns about the passwords', /pg_restore/.test(guide) && /server\.bat/.test(guide) && /ARE included/.test(guide))

const p2 = await backup({ scope: 'PROJECT', includeSecrets: false, includePackages: true })
const z2 = await zipEntries(path.join(BACKUPS, p2.file))
check(
  '2 options: without keys, with packages',
  p2.status === 'success' &&
    !z2.names.includes('project/backend/.env') &&
    !z2.names.some((n) => n.includes('secrets/')) &&
    z2.names.includes('project/backend/.env.example') &&
    z2.names.includes('project/admin-web/node_modules/pkg/index.js'),
  p2.error ?? ''
)
check('2 the second backup does not contain the first', !z2.names.some((n) => n.includes(p1.file)))

// ---- 3. Database only
const d1 = await backup({ scope: 'DATABASE' })
check('3 database backup succeeds', d1.status === 'success', d1.error ?? '')
check('3 named Database_Backup_<date>_<time>.zip', /^Database_Backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(_\d+)?\.zip$/.test(d1.file), d1.file)
const z3 = await zipEntries(path.join(BACKUPS, d1.file))
check('3 holds only the database (and its manifest)', z3.names.sort().join(',') === 'database.dump,manifest.json', z3.names.join(','))
const ov = await call('GET', '/system/backup/overview')
const listed = (f: string) => ov.json.backups.find((b: any) => b.name === f)
check('3 both kinds listed with their type', listed(p1.file)?.scope === 'PROJECT' && listed(d1.file)?.scope === 'DATABASE' && listed(d1.file)?.valid, JSON.stringify([listed(p1.file)?.scope, listed(d1.file)?.scope]))
check('3 history records the kind', ov.json.history.some((h: any) => h.file === d1.file && h.scope === 'DATABASE'))

// ---- 4. Restoring a Database only backup never touches the files
const [dept] = await db.insert(departments).values({ name: `After DB backup ${Date.now() % 100000}`, code: `ADB${Date.now() % 100000}` }).returning()
write('quality-checks/b.jpg', 'photo B, after the backup', UPLOADS)
const a1 = await waitJob((await call('POST', '/system/backup/restore/analyse', { file: d1.file })).json.id)
check('4 database backup analysed: no files, a note says files stay', a1.status === 'awaiting-choice' && a1.analysis.files.length === 0 && a1.analysis.notes.some((t: string) => /database only/i.test(t)), a1.error ?? '')
await call('POST', `/system/backup/restore/${a1.id}/apply`, { mode: 'FULL', confirm: 'RESTORE' })
const r1 = await waitJob(a1.id)
check('4 full restore of a database backup succeeds', r1.status === 'success', r1.error ?? '')
check('4 the database is the backup (newer record gone)', (await db.select().from(departments).where(eq(departments.id, dept.id))).length === 0)
check('4 the photos are untouched (old and new)', fs.existsSync(path.join(UPLOADS, 'quality-checks', 'a.jpg')) && fs.existsSync(path.join(UPLOADS, 'quality-checks', 'b.jpg')))
check('4 the file step says it was left alone', r1.steps.find((s: any) => s.key === 'restore-files')?.status === 'skipped')

// ---- 5. A Full project backup restores its data (database + photos)
fs.writeFileSync(path.join(UPLOADS, 'quality-checks', 'a.jpg'), 'photo A changed')
const a2 = await waitJob((await call('POST', '/system/backup/restore/analyse', { file: p1.file })).json.id)
check('5 project backup analysed, with a note about the project files', a2.status === 'awaiting-choice' && a2.analysis.notes.some((t: string) => /RESTORE\.txt/.test(t)), a2.error ?? '')
await call('POST', `/system/backup/restore/${a2.id}/apply`, { mode: 'REPLACE' })
const r2 = await waitJob(a2.id)
check('5 replace restore from a project backup succeeds', r2.status === 'success', r2.error ?? '')
check('5 changed photo back to the backup', fs.readFileSync(path.join(UPLOADS, 'quality-checks', 'a.jpg'), 'utf8') === 'photo A')
check('5 the project folder itself is not changed by a restore', fs.existsSync(path.join(PROJECT, 'admin-web', 'node_modules', 'pkg', 'index.js')))

// ---- 6. No temporary or partial files left
check('6 no .partial files', !fs.readdirSync(BACKUPS).some((n) => n.endsWith('.partial')))

for (const r of results) console.log(r)
console.log(`\n${passed} passed, ${failed} failed`)
await pool.end()
process.exit(failed ? 1 : 0)
