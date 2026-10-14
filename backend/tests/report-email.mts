/**
 * Report email delivery tests (npm run test:report-email): Sent / Failed / Retrying statuses, the
 * failure alert email and popup, retries, duplicate prevention, persistence and Super Admin access.
 * A fake mail server on 127.0.0.1:2526 stands in for the real one, so no real email is ever sent.
 *
 * They change data, so they refuse to run unless DATABASE_URL names a database ending in "_test":
 *   1. Copy the live database into pouchwale_quality_test.
 *   2. Start a server on the copy (migrations run at start), with its own outbox folder:
 *      DATABASE_URL=.../pouchwale_quality_test PUSH_DISABLED=1 ADMIN_PORT=0 PORT=4191 REPORT_OUTBOX_DIR=<tmp> npm start
 *   3. DATABASE_URL=.../pouchwale_quality_test REPORT_OUTBOX_DIR=<same tmp> npm run test:report-email
 *   4. Drop the copy.
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { db, pool } from '../src/db/client'
import { reportEmailAlerts, reportEmailLogs, reportEmailSettings, users } from '../src/db/schema'
import { signTokens } from '../src/lib/auth'
import { config } from '../src/config'
import { listReportEmailAlerts, markReportEmailAlert, processReportEmailRetries, resendReportEmail, sendLoggedEmail, smtpOf } from '../src/services/reportDelivery'
import { getReportSharingSettings, updateReportSharingSettings } from '../src/services/automatedReports'
import { resendDailyTaskReport } from '../src/services/dailyTaskReport'

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/none').pathname.slice(1)
if (!dbName.endsWith('_test')) {
  console.error('Refusing to run: DATABASE_URL must name a test database (ending in _test).')
  process.exit(2)
}
const BASE = `${process.env.RBAC_API ?? 'http://localhost:4191'}/api`
const SMTP_PORT = 2526

let passed = 0
let failed = 0
const results: string[] = []
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++
  else failed++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// ---------------------------------------------------------------------------- Fake mail server

const mode = { defer: false, authFail: false }
const received: { to: string[]; data: string }[] = []
let server: net.Server | null = null
const deliveredTo = (email: string) => received.filter((m) => m.to.includes(email)).length

function startSmtp() {
  return new Promise<void>((resolve) => {
    server = net.createServer((sock) => {
      sock.write('220 fake ESMTP\r\n')
      let buf = ''
      let inData = false
      let cur = { to: [] as string[], data: '' }
      const handle = (line: string) => {
        if (inData) {
          if (line === '.') {
            inData = false
            received.push(cur)
            cur = { to: [], data: '' }
            sock.write('250 2.0.0 OK queued\r\n')
          } else cur.data += line + '\n'
          return
        }
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250-AUTH PLAIN\r\n250 OK\r\n')
        else if (cmd === 'AUTH') sock.write(mode.authFail ? '535 5.7.8 Authentication credentials invalid\r\n' : '235 2.7.0 OK\r\n')
        else if (cmd === 'MAIL') {
          cur = { to: [], data: '' }
          sock.write('250 OK\r\n')
        } else if (cmd === 'RCPT') {
          const addr = /<([^>]*)>/.exec(line)?.[1] ?? ''
          if (addr.endsWith('@reject.test')) sock.write('550 5.1.1 User unknown\r\n')
          else if (addr.endsWith('@defer.test') && mode.defer) sock.write('451 4.3.0 Mailbox busy, try again later\r\n')
          else {
            cur.to.push(addr)
            sock.write('250 OK\r\n')
          }
        } else if (cmd === 'DATA') {
          inData = true
          sock.write('354 go ahead\r\n')
        } else if (cmd === 'QUIT') {
          sock.write('221 bye\r\n')
          sock.end()
        } else sock.write('250 OK\r\n')
      }
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1')
        let i
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 2)
          handle(line)
        }
      })
      sock.on('error', () => {})
    })
    server.listen(SMTP_PORT, '127.0.0.1', () => resolve())
  })
}
const stopSmtp = () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))

// ---------------------------------------------------------------------------- Helpers

async function tokenFor(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id))
  return signTokens(u, 'web').accessToken
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
const logRow = async (id: string) => (await db.select().from(reportEmailLogs).where(eq(reportEmailLogs.id, id)))[0]
const alertOf = async (logId: string) => (await db.select().from(reportEmailAlerts).where(eq(reportEmailAlerts.logId, logId)))
const logCount = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(reportEmailLogs))[0].n
const smtp = async () => smtpOf(await getReportSharingSettings())
const send = async (recipients: string[], trigger = 'DAILY', subject = `Test ${Date.now()}`, extra: Record<string, unknown> = {}) =>
  sendLoggedEmail({ log: { trigger, recipients, subject, checkIds: [], checksCount: 0, ...extra }, mail: { subject, html: '<p>test</p>' }, smtp: await smtp() })
const minutes = (m: number) => new Date(Date.now() + m * 60_000)

// ---------------------------------------------------------------------------- Setup

await startSmtp()
// The test copy talks to the fake server only. The schedule is off, so the test server's own
// scheduler sends nothing while these run.
await updateReportSharingSettings({
  isEnabled: false,
  smtpHost: '127.0.0.1',
  smtpPort: SMTP_PORT,
  smtpSecure: false,
  smtpUser: 'test-user',
  smtpPass: 'test-pass',
  smtpFrom: 'Quality Test <qa@ok.test>',
  recipients: ['a@ok.test', 'b@ok.test'],
  failureAlertEmail: 'alerts@ok.test'
})

// ---- 0. Migration
{
  const old = await db.select({ n: sql<number>`count(*)::int` }).from(reportEmailLogs).where(eq(reportEmailLogs.status, 'SUCCESS'))
  check('0 migration: no SUCCESS rows left (they are SENT now)', old[0].n === 0)
}

// ---- 1. Success: Sent only after the mail server accepted it
{
  const before = received.length
  const r = await send(['a@ok.test', 'b@ok.test'])
  const row = await logRow(r.logId)
  check(
    '1a success: status SENT, both recipients SENT, message id kept, one message to the server',
    r.status === 'SENT' && row.status === 'SENT' && row.recipientStatus.every((x) => x.status === 'SENT') && !!row.messageId && received.length === before + 1,
    `${r.status}`
  )
  check('1b no alert for a sent email; the kept copy is removed', (await alertOf(r.logId)).length === 0 && !fs.existsSync(path.join(config.reportOutboxDir, `${r.logId}.eml`)))
}

// ---- 2. Permanent failure for one recipient: Failed with the real reason, alert email sent once
{
  const alertsBefore = deliveredTo('alerts@ok.test')
  const r = await send(['a@ok.test', 'nobody@reject.test'])
  const row = await logRow(r.logId)
  const bad = row.recipientStatus.find((x) => x.email === 'nobody@reject.test')
  check(
    '2a refused address: FAILED, the other recipient SENT, the server’s reason shown, not retried',
    r.status === 'FAILED' && row.recipientStatus.find((x) => x.email === 'a@ok.test')?.status === 'SENT' && /550 5\.1\.1 User unknown/.test(bad?.error ?? '') && row.failureKind === 'PERMANENT' && row.nextRetryAt === null,
    bad?.error ?? ''
  )
  const [alert] = await alertOf(r.logId)
  check('2b popup record created with the intended recipient and reason', !!alert && alert.failedRecipients.includes('nobody@reject.test') && /User unknown/.test(alert.errorMessage ?? ''))
  check('2c failure alert email sent to the configured address', alert?.alertEmailStatus === 'SENT' && alert.alertEmailTo === 'alerts@ok.test' && deliveredTo('alerts@ok.test') === alertsBefore + 1)
  const mail = received.filter((m) => m.to.includes('alerts@ok.test')).at(-1)?.data ?? ''
  check('2d alert email names the schedule, log id, recipient, time, error and retry status', [/Daily previous-day task report/, new RegExp(r.logId), /nobody@reject\.test/, /Failed at/, /User unknown/, /Retry status/].every((re) => re.test(mail)))
}

// ---- 3. Temporary failure: Retrying, then sent on the retry, only to whom it failed for
{
  mode.defer = true
  const aBefore = deliveredTo('a@ok.test')
  const r = await send(['a@ok.test', 'slow@defer.test'])
  const row = await logRow(r.logId)
  check(
    '3a temporary failure: RETRYING, next retry about 5 minutes later, attempt 1',
    r.status === 'RETRYING' && row.attempts === 1 && !!row.nextRetryAt && Math.abs(row.nextRetryAt.getTime() - (row.lastAttemptAt!.getTime() + 5 * 60_000)) < 5_000
  )
  const notDue = await processReportEmailRetries(new Date())
  check('3b nothing is resent before the retry time', (await logRow(r.logId)).attempts === 1, JSON.stringify(notDue))
  mode.defer = false
  const due = new Date(row.nextRetryAt!.getTime() + 1000)
  const [x, y] = await Promise.all([processReportEmailRetries(due), processReportEmailRetries(due)])
  const after = await logRow(r.logId)
  check(
    '3c retry succeeds: SENT, recovery time recorded, attempts 2',
    after.status === 'SENT' && !!after.recoveredAt && after.attempts === 2,
    `${after.status} ${after.attempts} ${JSON.stringify([x, y])}`
  )
  check('3d no duplicates: the first recipient got it once, the deferred one once (two retry runs at the same moment)', deliveredTo('a@ok.test') === aBefore + 1 && deliveredTo('slow@defer.test') === 1)
  const [alert] = await alertOf(r.logId)
  const listed = (await listReportEmailAlerts({ open: true })).find((a) => a.logId === r.logId)
  check('3e the alert stays, showing the email recovered', !!alert && listed?.email.status === 'SENT' && /Sent after retrying/.test(listed?.email.retryStatus ?? ''))
}

// ---- 4. Retries end: four attempts, then FAILED for good
{
  mode.defer = true
  const r = await send(['late@defer.test'])
  let row = await logRow(r.logId)
  for (let i = 0; i < 3; i++) {
    await processReportEmailRetries(new Date(row.nextRetryAt!.getTime() + 1000))
    row = await logRow(r.logId)
  }
  check('4a after 1 send + 3 retries: FAILED, no further retry planned', row.status === 'FAILED' && row.attempts === 4 && row.nextRetryAt === null, `${row.status} ${row.attempts}`)
  const sentBefore = received.length
  await processReportEmailRetries(minutes(24 * 60))
  check('4b not retried again later', received.length === sentBefore && (await logRow(r.logId)).attempts === 4)
  check('4c still one alert for the whole incident', (await alertOf(r.logId)).length === 1)
  mode.defer = false
}

// ---- 5. Alert email: once per error in 6 hours, not configured, and no loop when it fails
{
  // Section 2's alert email was for the same refusal: make it older than the 6 hours.
  await db.update(reportEmailAlerts).set({ alertEmailAt: minutes(-7 * 60) }).where(eq(reportEmailAlerts.alertEmailStatus, 'SENT'))
  const first = await send(['x1@reject.test'])
  const second = await send(['x1@reject.test'])
  const [a1] = await alertOf(first.logId)
  const [a2] = await alertOf(second.logId)
  check('5a the same error again shortly after: popup yes, second alert email no (SKIPPED)', a1?.alertEmailStatus === 'SENT' && a2?.alertEmailStatus === 'SKIPPED')

  await db.update(reportEmailSettings).set({ failureAlertEmail: null })
  const third = await send(['x3@reject.test'])
  const [a3] = await alertOf(third.logId)
  check('5b no failure alert email set: recorded as NOT_CONFIGURED (shown to the Super Admin)', a3?.alertEmailStatus === 'NOT_CONFIGURED')
  await db.update(reportEmailSettings).set({ failureAlertEmail: 'alerts@ok.test' })

  // The mail server is down: the report fails (temporary) and so does the alert email.
  await stopSmtp()
  const logsBefore = await logCount()
  const down = await send(['a@ok.test'])
  const [a4] = await alertOf(down.logId)
  check(
    '5c mail server down: report RETRYING, alert email FAILED and recorded, no extra log rows (no loop)',
    down.status === 'RETRYING' && a4?.alertEmailStatus === 'FAILED' && !!a4.alertEmailError && (await logCount()) === logsBefore + 1,
    `${down.status} ${a4?.alertEmailStatus} ${a4?.alertEmailError ?? ''}`
  )
  await startSmtp()
  await db.update(reportEmailLogs).set({ status: 'SENT', nextRetryAt: null }).where(eq(reportEmailLogs.id, down.logId))
}

// ---- 6. Wrong login is permanent; manual sends never alert
{
  mode.authFail = true
  const r = await send(['a@ok.test'])
  check('6a wrong SMTP login: FAILED at once (permanent), not retried', r.status === 'FAILED' && (await logRow(r.logId)).failureKind === 'PERMANENT' && r.nextRetryAt === null)
  mode.authFail = false
  const sa = (await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN')))[0]
  const manual = await send(['m@reject.test'], 'MANUAL', 'Manual test', { sentById: sa.id, sentByName: sa.name })
  check('6b a person’s own send that fails raises no popup or alert email (they see the error)', manual.status === 'FAILED' && (await alertOf(manual.logId)).length === 0)
  ;(globalThis as any).permanentLog = r.logId
}

// ---- 7. Interrupted send: marked FAILED, not resent automatically
{
  const [row] = await db
    .insert(reportEmailLogs)
    .values({ trigger: 'DAILY', recipients: ['i@ok.test'], subject: 'Interrupted', checkIds: [], status: 'PENDING', recipientStatus: [{ email: 'i@ok.test', status: 'PENDING' }], attempts: 1, lastAttemptAt: minutes(-40) })
    .returning()
  const before = deliveredTo('i@ok.test')
  await processReportEmailRetries(new Date())
  const after = await logRow(row.id)
  check('7 interrupted send: FAILED with a clear reason and an alert, nothing resent', after.status === 'FAILED' && /interrupted/i.test(after.errorMessage ?? '') && (await alertOf(row.id)).length === 1 && deliveredTo('i@ok.test') === before)
}

// ---- 8. Existing sending still works: Resend today's report (real report, PDF attached)
{
  const before = deliveredTo('b@ok.test')
  const result = await resendDailyTaskReport({ name: 'test' })
  check('8 Resend today’s report: SENT to both recipients through the new delivery', result.success && deliveredTo('b@ok.test') === before + 1, result.error ?? '')
}

// ---- 9. Persistence, read / dismiss
{
  const open = await listReportEmailAlerts({ open: true })
  const one = open[0]
  const read = await markReportEmailAlert(one.id, 'read', (await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN')))[0].id)
  check('9a alerts are stored and listed for the popup; opening marks it read', open.length >= 5 && !!read.readAt && !read.dismissedAt)
  const dismissed = await markReportEmailAlert(one.id, 'dismiss', read.readById!)
  const openAfter = await listReportEmailAlerts({ open: true })
  const stillThere = await db.select().from(reportEmailAlerts).where(eq(reportEmailAlerts.id, one.id))
  check('9b dismiss: no longer in the popup list, the record is kept', !!dismissed.dismissedAt && !openAfter.some((a) => a.id === one.id) && stillThere.length === 1)
}

// ---- 10. Super Admin only, over the API; Retry Sending
{
  const [sa] = await db.select().from(users).where(eq(users.role, 'SUPER_ADMIN'))
  const [mgr] = await db.select().from(users).where(eq(users.role, 'MANAGER'))
  const SA = await tokenFor(sa.id)
  const MGR = await tokenFor(mgr.id)
  const created = await call(SA, 'POST', '/users', { employeeId: `TMA${Date.now().toString().slice(-6)}`, name: 'Mail test admin', role: 'ADMIN', password: 'secret12' })
  const ADMIN = await tokenFor(created.json.id)

  const a = await call(SA, 'GET', '/reports/sharing/alerts?open=1')
  const b = await call(ADMIN, 'GET', '/reports/sharing/alerts?open=1')
  const c = await call(MGR, 'GET', '/reports/sharing/alerts?open=1')
  check('10a alerts: Super Admin 200, Admin 403, Manager 403', a.status === 200 && Array.isArray(a.json) && b.status === 403 && c.status === 403, `${a.status},${b.status},${c.status}`)

  const permanent = (globalThis as any).permanentLog as string
  const target = a.json.find((x: any) => x.canRetry && x.logId !== permanent)
  const d = await call(ADMIN, 'POST', `/reports/sharing/logs/${target.logId}/retry`)
  const e = await call(ADMIN, 'POST', `/reports/sharing/alerts/${target.id}/dismiss`)
  check('10b Admin cannot retry or dismiss', d.status === 403 && e.status === 403)

  // The wrong-login email from 6a, now that the login works: Retry Sending sends it.
  const f = await call(SA, 'POST', `/reports/sharing/logs/${permanent}/retry`)
  const g = await call(SA, 'POST', `/reports/sharing/logs/${permanent}/retry`)
  check('10c Super Admin Retry Sending: SENT; a second retry of a sent email is refused (409)', f.status === 200 && f.json.status === 'SENT' && g.status === 409, `${f.status} ${f.json?.status} ${g.status}`)

  fs.rmSync(path.join(config.reportOutboxDir, `${target.logId}.eml`), { force: true })
  const h = await call(SA, 'POST', `/reports/sharing/logs/${target.logId}/retry`)
  check('10d original no longer stored: Retry explains it (400), nothing sent', h.status === 400 && /no longer stored/.test(h.json?.error ?? ''), `${h.status} ${h.json?.error ?? ''}`)

  const s1 = await call(ADMIN, 'PUT', '/reports/sharing/settings', { failureAlertEmail: 'someone@else.test' })
  const s2 = await call(SA, 'PUT', '/reports/sharing/settings', { failureAlertEmail: 'bad address' })
  const s3 = await call(SA, 'PUT', '/reports/sharing/settings', { failureAlertEmail: 'alerts2@ok.test' })
  const s4 = await call(SA, 'GET', '/reports/sharing/settings')
  check(
    '10e failure alert email: Admin cannot change it (403), invalid refused (400), Super Admin saves it; SMTP password still masked',
    s1.status === 403 && s2.status === 400 && s3.status === 200 && s4.json.failureAlertEmail === 'alerts2@ok.test' && s4.json.smtpPass === '••••••••',
    `${s1.status},${s2.status},${s3.status}`
  )
  const logs = await call(SA, 'GET', '/reports/sharing/logs')
  check('10f Delivery log shows the new statuses and per-recipient results', logs.status === 200 && logs.json.some((l: any) => l.status === 'RETRYING' || l.status === 'FAILED') && logs.json.some((l: any) => l.recipientStatus?.length > 1))
}

await stopSmtp()
console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
await pool.end()
