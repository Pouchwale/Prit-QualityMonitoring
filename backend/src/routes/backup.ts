import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireRole } from '../lib/auth'
import { HttpError, notFound } from '../lib/http'
import { db } from '../db/client'
import { auditLogs } from '../db/schema'
import * as backup from '../services/backup'

/**
 * Backup & Restore (services/backup.ts). Super Admin only: every route here refuses anyone else,
 * whatever the menu shows. The job status (GET /api/backup-jobs/:id) and the one-time download
 * links are served in app.ts, so they keep working while a restore pauses the API.
 */
export const backupRouter = Router()
backupRouter.use(requireRole('SUPER_ADMIN'))

const who = (req: Request) => `${req.user!.name} (${req.user!.employeeId})`

/** Service errors are the user's to read ("a restore is already running"…): 409. */
function attempt<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    throw new HttpError(409, (err as Error).message)
  }
}

/** Audit log entry for a finished job (the user may be gone after a full restore: then by name only). */
function auditJob(req: Request) {
  return async (job: backup.Job) => {
    const entry = {
      userName: who(req),
      role: req.user!.role,
      action: job.kind === 'BACKUP' ? 'BACKUP_CREATE' : 'BACKUP_RESTORE',
      entity: 'Backup',
      entityId: job.id,
      newValue: {
        status: job.status,
        title: job.title,
        file: job.file,
        mode: job.mode,
        error: job.error,
        safetyBackup: job.result?.safetyBackup ?? null,
        bytes: job.result?.bytes ?? null
      },
      ipAddress: req.ip
    }
    try {
      await db.insert(auditLogs).values({ ...entry, userId: req.user!.id })
    } catch {
      await db.insert(auditLogs).values({ ...entry, userId: null })
    }
  }
}

backupRouter.get('/overview', async (_req, res) => {
  const [tools, backups] = await Promise.all([backup.toolStatus(), backup.listBackups()])
  const history = backup.history()
  res.json({
    location: backup.backupLocation(),
    defaultLocation: backup.DEFAULT_BACKUP_DIR,
    tools,
    backups,
    history: history.slice(0, 200),
    lastBackup: history.find((h) => h.kind === 'BACKUP' && h.status === 'SUCCESS') ?? null,
    lastAttempt: history.find((h) => h.kind === 'BACKUP') ?? null,
    activeJob: backup.currentJob()
  })
})

backupRouter.put('/location', async (req, res) => {
  const { path: folder } = z.object({ path: z.string().max(500).nullable() }).parse(req.body)
  try {
    const location = await backup.setBackupLocation(folder)
    res.json({ location })
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
})

/**
 * The kind of backup: PROJECT (the whole project folder, the database and the files), DATABASE
 * (the database only). DATA (database and files) when none is given, as before there was a choice.
 */
const backupChoice = z.object({
  scope: z.enum(['PROJECT', 'DATABASE', 'DATA']).default('DATA'),
  includeSecrets: z.boolean().optional(),
  includePackages: z.boolean().optional()
})

backupRouter.post('/backups', (req, res) => {
  const { scope, ...options } = backupChoice.parse(req.body ?? {})
  const job = attempt(() => backup.startBackup(who(req), scope, options, auditJob(req)))
  res.status(202).json(job)
})

/** What a backup would hold (files and sizes), shown before it is started. */
backupRouter.get('/estimate', async (req, res) => {
  const q = z
    .object({ scope: z.enum(['PROJECT', 'DATABASE', 'DATA']).default('PROJECT'), secrets: z.enum(['0', '1']).default('1'), packages: z.enum(['0', '1']).default('0') })
    .parse(req.query)
  res.json(await backup.estimateBackup(q.scope, { includeSecrets: q.secrets === '1', includePackages: q.packages === '1' }))
})

backupRouter.post('/backups/:name/download-link', (req, res) => {
  const file = backup.resolveBackupFile(String(req.params.name))
  if (!file) throw notFound('Backup file')
  res.json({ url: `/api/backup-download/${backup.downloadTicket(file)}` })
})

backupRouter.post('/restore/analyse', (req, res) => {
  const { file: name } = z.object({ file: z.string().min(1).max(300) }).parse(req.body)
  const file = backup.resolveBackupFile(name)
  if (!file) throw notFound('Backup file')
  res.status(202).json(attempt(() => backup.startRestoreAnalysis(who(req), file, false, name)))
})

// A backup file from the Super Admin's computer: saved to the work folder, removed after the restore.
const incoming = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(backup.INCOMING_DIR, { recursive: true })
      cb(null, backup.INCOMING_DIR)
    },
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.zip`)
  }),
  limits: { fileSize: 50 * 1024 ** 3, files: 1 },
  fileFilter: (_req, file, cb) => (/\.zip$/i.test(file.originalname) ? cb(null, true) : cb(new HttpError(400, 'Choose a backup .zip file made by Backup & Restore.')))
}).single('file')

backupRouter.post('/restore/upload', incoming, (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a backup file.')
  const name = path.basename(req.file.originalname)
  try {
    res.status(202).json(backup.startRestoreAnalysis(who(req), req.file.path, true, name))
  } catch (err) {
    fs.rmSync(req.file.path, { force: true })
    throw new HttpError(409, (err as Error).message)
  }
})

backupRouter.post('/restore/:id/apply', (req, res) => {
  const { mode, confirm } = z.object({ mode: z.enum(['SKIP', 'REPLACE', 'FULL']), confirm: z.string().optional() }).parse(req.body)
  // A full restore overwrites everything: it must be typed out, not just clicked.
  if (mode === 'FULL' && confirm?.trim().toUpperCase() !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm a full restore.')
  res.status(202).json(attempt(() => backup.applyRestore(String(req.params.id), mode, who(req), auditJob(req))))
})

backupRouter.post('/restore/:id/cancel', async (req, res) => {
  res.json({ cancelled: await backup.cancelRestore(String(req.params.id)) })
})

/** A job's progress, by its unguessable ID (also during a restore, and after one signs the user out). */
export function backupJobStatus(req: Request, res: Response) {
  const job = backup.getJob(String(req.params.id))
  if (!job) throw notFound('Backup job')
  res.json(job)
}

/** A one-time download link (valid one minute): the file streams straight to disk. */
export function backupDownload(req: Request, res: Response) {
  const file = backup.useTicket(String(req.params.ticket))
  if (!file) throw new HttpError(404, 'This download link has expired. Click Download again.')
  res.download(file, path.basename(file))
}
