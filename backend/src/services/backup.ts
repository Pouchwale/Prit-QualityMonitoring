/**
 * Backup & Restore (Super Admin only, routes/backup.ts).
 *
 * A backup is one .zip file:
 *   manifest.json   what is inside: who made it and when, the software / database version, row
 *                   counts, and a SHA-256 checksum of every other entry
 *   database.dump   the whole PostgreSQL database (pg_dump custom format: schema, tables, records,
 *                   relationships, indexes, constraints, sequences, enum types)
 *   files/<set>/…   uploaded photos and videos, Plant Calendar documents and report emails as sent
 * It is written as "<name>.zip.partial" and only renamed to .zip after every entry has been read
 * back and checked, so an interrupted or broken backup is never listed as a good one.
 *
 * A restore never touches the live data until the Super Admin has chosen how to restore:
 *   1. the backup is unpacked and every checksum checked;
 *   2. its database is loaded into a temporary database and upgraded to this software's version
 *      (the same migrations the server runs at start), so an older backup fits the current tables;
 *   3. it is compared with the live data: records and files that already exist (same ID / path),
 *      identical or different, and new ones.
 * Then, after a safety backup of the current data, the live data is changed with the API paused
 * (maintenance mode):
 *   SKIP     adds only records and files that do not exist yet;
 *   REPLACE  adds new records and overwrites existing ones (same ID) with the backup's version;
 *   FULL     the database and the files become exactly the backup.
 * Database changes run in one transaction: if anything fails, nothing is changed. A full restore
 * whose file step fails puts the database back from the safety backup.
 *
 * Not included: backend/.env and backend/secrets (passwords and keys never go in a backup file).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import yauzl from 'yauzl'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { config } from '../config'
import { pool } from '../db/client'
import { localParts } from '../lib/time'
import { CALENDAR_DOCS_DIR } from './calendarYears'

// ------------------------------------------------------------------------------------- locations

const BACKEND_DIR = process.cwd()
/** "Database Backup" in the project folder, unless BACKUP_DIR says otherwise. */
export const DEFAULT_BACKUP_DIR = path.resolve(process.env.BACKUP_DIR ?? path.join(BACKEND_DIR, '..', 'Database Backup'))
/** The chosen folder and the history; kept outside the database, so a restore never loses them. */
const STATE_FILE = path.resolve(BACKEND_DIR, process.env.BACKUP_STATE_FILE ?? 'backup-state.json')
/** Temporary work (unpacked backups, uploads); emptied after every job. */
const WORK_ROOT = path.resolve(BACKEND_DIR, process.env.BACKUP_WORK_DIR ?? '.backup-work')
const MIGRATIONS_DIR = path.resolve(BACKEND_DIR, 'drizzle')
/** The whole project folder, for a Full project backup (PROJECT_DIR; a separate folder for tests). */
const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR ?? path.join(BACKEND_DIR, '..'))
export const INCOMING_DIR = path.join(WORK_ROOT, 'incoming')

const FORMAT = 'quality-monitoring-backup'
const FORMAT_VERSION = 1

/** The project's file folders that go in a backup. */
function fileSets() {
  return [
    { key: 'uploads', label: 'Photos, videos and evidence', dir: config.uploadDir, skip: new Set(['.tmp']) },
    { key: 'calendar-documents', label: 'Plant Calendar documents', dir: CALENDAR_DOCS_DIR, skip: new Set<string>() },
    { key: 'report-outbox', label: 'Report emails as sent', dir: config.reportOutboxDir, skip: new Set<string>() }
  ]
}

// ----------------------------------------------------------------------------------- saved state

export type RestoreMode = 'SKIP' | 'REPLACE' | 'FULL'

/**
 * What a backup holds:
 *   PROJECT   the whole project folder (code, apps, settings, builds…), the database and the files
 *   DATABASE  the database only
 *   DATA      the database and the uploaded files (photos, documents): safety backups, and every
 *             backup made before there was a choice
 */
export type BackupScope = 'PROJECT' | 'DATABASE' | 'DATA'

export interface BackupOptions {
  /** Full project only: backend\.env, backend\secrets and key files (default: included). */
  includeSecrets?: boolean
  /** Full project only: installed packages (node_modules), which server.bat reinstalls (default: left out). */
  includePackages?: boolean
}

export interface HistoryEntry {
  id: string
  kind: 'BACKUP' | 'SAFETY_BACKUP' | 'RESTORE'
  /** What a backup holds (older entries: DATA). */
  scope?: BackupScope
  status: 'SUCCESS' | 'FAILED'
  startedAt: string
  finishedAt: string
  by: string
  file?: string
  folder?: string
  bytes?: number
  mode?: RestoreMode
  summary?: string
  error?: string
}

interface State {
  location: string | null
  history: HistoryEntry[]
}

function readState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<State>
    return { location: typeof s.location === 'string' ? s.location : null, history: Array.isArray(s.history) ? s.history : [] }
  } catch {
    return { location: null, history: [] }
  }
}

function writeState(state: State) {
  const tmp = `${STATE_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

function addHistory(entry: HistoryEntry) {
  const state = readState()
  state.history = [entry, ...state.history].slice(0, 500)
  writeState(state)
}

export const backupLocation = () => readState().location ?? DEFAULT_BACKUP_DIR

/** Sets the folder new backups go to (blank: the default "Database Backup" folder). */
export async function setBackupLocation(folder: string | null) {
  const state = readState()
  if (!folder || !folder.trim()) {
    state.location = null
    writeState(state)
    return DEFAULT_BACKUP_DIR
  }
  const dir = path.resolve(folder.trim())
  if (!path.isAbsolute(folder.trim())) throw new Error('Enter a full folder path, e.g. D:\\Backups\\Quality.')
  const inside = (parent: string) => dir === parent || dir.startsWith(parent + path.sep)
  for (const set of fileSets()) {
    if (inside(set.dir)) throw new Error(`Backups cannot be kept inside the ${set.label.toLowerCase()} folder.`)
  }
  if (inside(WORK_ROOT)) throw new Error('Choose another folder.')
  try {
    await fsp.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${crypto.randomUUID()}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe, { force: true })
  } catch (err) {
    throw new Error(`The server cannot write to ${dir}: ${(err as Error).message}`)
  }
  state.location = dir
  writeState(state)
  return dir
}

// ---------------------------------------------------------------------------------- maintenance

let maintenance = false
/** True while a restore changes the live data: the API answers 503 and the scheduler waits. */
export const isMaintenance = () => maintenance

// ------------------------------------------------------------------------------ PostgreSQL tools

function findToolDir(): string | null {
  if (process.env.PG_BIN) return path.resolve(process.env.PG_BIN)
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      const root = path.join(base, 'PostgreSQL')
      try {
        const versions = fs
          .readdirSync(root)
          .filter((v) => fs.existsSync(path.join(root, v, 'bin', 'pg_dump.exe')))
          .sort((a, b) => parseFloat(b) - parseFloat(a))
        if (versions.length) return path.join(root, versions[0], 'bin')
      } catch {
        /* not installed here */
      }
    }
  }
  return null
}

function tool(name: 'pg_dump' | 'pg_restore' | 'psql') {
  const dir = findToolDir()
  return dir ? path.join(dir, process.platform === 'win32' ? `${name}.exe` : name) : name
}

function dbUrl(database?: string) {
  const url = new URL(config.databaseUrl)
  if (database) url.pathname = `/${encodeURIComponent(database)}`
  return url
}

const liveDbName = () => decodeURIComponent(dbUrl().pathname.slice(1))
const stageDbName = () => `${liveDbName()}_restore_stage`.slice(0, 63)

/** Connection settings for the PostgreSQL tools, as environment variables (never on the command line). */
function pgEnv(database: string): NodeJS.ProcessEnv {
  const url = dbUrl()
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: '15',
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {})
  }
}

/** Removes the database password from text that may be shown or saved. */
function clean(text: string) {
  const password = decodeURIComponent(dbUrl().password)
  let out = text
  if (password) out = out.split(password).join('***')
  return out.replace(/postgres(ql)?:\/\/[^\s@]*@/gi, 'postgres://***@').trim()
}

/** Runs a PostgreSQL tool; rejects with its error output (without the password) when it fails. */
function runTool(name: 'pg_dump' | 'pg_restore' | 'psql', args: string[], database: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(name), args, { env: pgEnv(database), windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out = (out + d).slice(-200_000)))
    child.stderr.on('data', (d) => (err = (err + d).slice(-20_000)))
    child.on('error', (e) =>
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${name} was not found. Install the PostgreSQL tools or set PG_BIN in backend\\.env.` : clean(e.message)))
    )
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${name} failed: ${clean(err) || `exit code ${code}`}`))))
  })
}

/** The PostgreSQL tools' version, and whether they can back up this server. */
export async function toolStatus(): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  try {
    const version = (await runTool('pg_dump', ['--version'], liveDbName())).trim()
    const toolMajor = Number(/(\d+)/.exec(version.replace(/^\D+/, ''))?.[1])
    const server = Number((await pool.query<{ v: string }>('SHOW server_version_num')).rows[0].v)
    const serverMajor = Math.floor(server / 10000)
    if (toolMajor && serverMajor && toolMajor < serverMajor) {
      return { ok: false, version, error: `pg_dump ${toolMajor} is older than the database server (${serverMajor}). Install PostgreSQL ${serverMajor} tools.` }
    }
    return { ok: true, version, error: null }
  } catch (err) {
    return { ok: false, version: null, error: (err as Error).message }
  }
}

// ------------------------------------------------------------------------------------------ jobs

export interface Step {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  detail?: string
}

export interface TableComparison {
  table: string
  backupRows: number
  liveRows: number
  sameId: number
  identical: number
  different: number
  newRows: number
}

export interface FileComparison {
  key: string
  label: string
  backupFiles: number
  backupBytes: number
  existing: number
  identical: number
  different: number
  newFiles: number
  liveOnly: number
}

export interface Analysis {
  backup: { file: string; createdAt: string; createdBy: string; appVersion: string; kind: string; scope: BackupScope; bytes: number }
  /** About what this backup restores (e.g. a database-only backup leaves the files alone). */
  notes: string[]
  tables: TableComparison[]
  files: FileComparison[]
  totals: { backupRows: number; sameId: number; different: number; newRows: number; backupFiles: number; existingFiles: number; newFiles: number }
  duplicates: boolean
  warnings: string[]
}

export interface TableResult {
  table: string
  added: number
  updated: number
  unchanged: number
  failed: number
  errors: string[]
}

export interface Job {
  id: string
  kind: 'BACKUP' | 'RESTORE'
  status: 'running' | 'awaiting-choice' | 'success' | 'failed' | 'cancelled'
  title: string
  percent: number
  steps: Step[]
  message: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  by: string
  file: string | null
  analysis: Analysis | null
  mode: RestoreMode | null
  result: { tables?: TableResult[]; files?: { copied: number; skipped: number; failed: number }; safetyBackup?: string | null; bytes?: number } | null
}

interface Internal {
  work: string
  zip: string | null
  uploaded: boolean
  manifest: Manifest | null
  expiry: NodeJS.Timeout | null
}

const jobs = new Map<string, Job>()
const internals = new Map<string, Internal>()
/** The job that holds the lock: one backup or restore at a time. */
let activeJob: string | null = null

export const getJob = (id: string) => jobs.get(id) ?? null
export const currentJob = () => (activeJob ? (jobs.get(activeJob) ?? null) : null)

function newJob(kind: Job['kind'], title: string, by: string, steps: [string, string][]): Job {
  if (activeJob) {
    const busy = jobs.get(activeJob)
    throw new Error(busy?.status === 'awaiting-choice' ? 'A restore is waiting for your choice. Finish or cancel it first.' : 'A backup or restore is already running. Please wait for it to finish.')
  }
  const job: Job = {
    id: crypto.randomUUID(),
    kind,
    status: 'running',
    title,
    percent: 0,
    steps: steps.map(([key, label]) => ({ key, label, status: 'pending' })),
    message: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    by,
    file: null,
    analysis: null,
    mode: null,
    result: null
  }
  jobs.set(job.id, job)
  // Keep the last few finished jobs for their status pages.
  for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 20))) if (old !== job.id) jobs.delete(old)
  activeJob = job.id
  return job
}

function step(job: Job, key: string, status: Step['status'], detail?: string) {
  const s = job.steps.find((x) => x.key === key)
  if (!s) return
  s.status = status
  if (detail !== undefined) s.detail = detail
  if (status === 'running') job.message = s.label
}

function release(job: Job) {
  if (activeJob === job.id) activeJob = null
}

// ------------------------------------------------------------------------------------- manifest

interface Manifest {
  format: string
  formatVersion: number
  createdAt: string
  createdBy: string
  kind: 'BACKUP' | 'SAFETY_BACKUP'
  /** Missing in backups made before there was a choice: those are DATA backups. */
  scope?: BackupScope
  app: { name: string; version: string }
  database: {
    name: string
    serverVersion: string
    migrations: { count: number; lastCreatedAt: number | null }
    tables: Record<string, number>
    file: string
  }
  files: { key: string; label: string; count: number; bytes: number }[]
  checksums: Record<string, string>
  sizes: Record<string, number>
  passwordKeyFingerprint: string | null
  /** Full project backups: the project folder, under project/ in the file. */
  project?: { root: string; count: number; bytes: number; includesSecrets: boolean; includesPackages: boolean; skippedBackups: number }
  /** Files that disappeared while the backup was written (stored empty). */
  missing?: string[]
}

const scopeOf = (m: Manifest): BackupScope => m.scope ?? 'DATA'

const appVersion = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8')) as { version?: string }).version ?? '0'
  } catch {
    return '0'
  }
})()

/** The newest migration this software has (drizzle/meta/_journal.json). */
function localMigrations(): { count: number; last: number } {
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number }[] }
  return { count: journal.entries.length, last: Math.max(...journal.entries.map((e) => e.when)) }
}

/** A short fingerprint of the key that protects saved passwords (never the key itself). */
function passwordKeyFingerprint(): string | null {
  try {
    const file = path.resolve(BACKEND_DIR, process.env.PASSWORD_VIEW_KEY_FILE ?? 'secrets/password-view.key')
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------- files

interface FileItem {
  rel: string
  abs: string
  size: number
}

async function walk(root: string, skip: Set<string>): Promise<FileItem[]> {
  const out: FileItem[] = []
  async function visit(dir: string, rel: string) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const e of entries) {
      if (!rel && skip.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await visit(abs, r)
      else if (e.isFile()) out.push({ rel: r, abs, size: (await fsp.stat(abs)).size })
    }
  }
  await visit(root, '')
  return out
}

/**
 * A file read only when the zip writer reaches it (so thousands of files never hold thousands of
 * handles), hashed as it streams into the zip. A file deleted in the meantime goes in empty and is
 * reported; a file that changes while it is read is stored as read, with that content's checksum.
 */
class HashedFile extends Readable {
  private src: fs.ReadStream | null = null
  private readonly hash = crypto.createHash('sha256')
  private bytes = 0
  constructor(
    private readonly file: string,
    private readonly done: (sha: string, bytes: number, missing: boolean) => void,
    private readonly progress: (bytes: number) => void
  ) {
    super()
  }
  override _read() {
    if (this.src) {
      this.src.resume()
      return
    }
    this.src = fs.createReadStream(this.file)
    this.src.on('data', (chunk) => {
      const c = chunk as Buffer
      this.hash.update(c)
      this.bytes += c.length
      this.progress(c.length)
      if (!this.push(c)) this.src!.pause()
    })
    this.src.on('end', () => {
      this.done(this.hash.digest('hex'), this.bytes, false)
      this.push(null)
    })
    this.src.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && this.bytes === 0) {
        this.done(this.hash.digest('hex'), 0, true)
        this.push(null)
      } else this.destroy(err)
    })
  }
}

/** Key and password files (as in .gitignore): left out of a Full project backup unless chosen. */
const SECRET_FILE = /^(\.env(\..+)?|.+\.(key|pem|p12|p8|jks|keystore)|google-services\.json|GoogleService-Info\.plist|.*service-account.*\.json)$/i

/**
 * Every file of the project folder for a Full project backup. Left out: the uploaded files (they go
 * under files/, as in every backup), .git, temporary backup work, earlier backup files (a backup
 * inside the next would make each one bigger than the last), and, unless chosen, installed packages
 * and key files.
 */
async function walkProject(opts: BackupOptions) {
  const dataDirs = new Set(fileSets().map((f) => path.resolve(f.dir)))
  const backupDirs = new Set([path.resolve(backupLocation()), path.resolve(DEFAULT_BACKUP_DIR)])
  const items: FileItem[] = []
  let skippedBackups = 0
  async function visit(dir: string, rel: string) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return
      throw err
    }
    // The backup folders (also an old "Database Backup" folder after the location was changed).
    const inBackupDir = backupDirs.has(path.resolve(dir)) || path.basename(dir).toLowerCase() === 'database backup'
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (e.name === '.git' || path.resolve(abs) === WORK_ROOT || dataDirs.has(path.resolve(abs))) continue
        if (e.name === 'node_modules' && !opts.includePackages) continue
        if (!opts.includeSecrets && (r === 'backend/secrets' || e.name === 'certs')) continue
        await visit(abs, r)
      } else if (e.isFile()) {
        if (inBackupDir && /\.zip(\.partial)?$/i.test(e.name)) {
          skippedBackups++
          continue
        }
        if (!opts.includeSecrets && SECRET_FILE.test(e.name) && e.name !== '.env.example') continue
        const st = await fsp.stat(abs).catch(() => null)
        if (st) items.push({ rel: r, abs, size: st.size })
      }
    }
  }
  await visit(PROJECT_DIR, '')
  return { items, skippedBackups }
}

/** What a backup of this kind would hold, for the confirmation before it starts. */
export async function estimateBackup(scope: BackupScope, opts: BackupOptions) {
  const size = (list: FileItem[]) => list.reduce((a, b) => a + b.size, 0)
  const database = Number((await pool.query<{ n: string }>('SELECT pg_database_size(current_database()) AS n')).rows[0].n)
  const data = scope === 'DATABASE' ? [] : (await Promise.all(fileSets().map((f) => walk(f.dir, f.skip)))).flat()
  const project = scope === 'PROJECT' ? await walkProject(opts) : null
  return {
    scope,
    projectDir: scope === 'PROJECT' ? PROJECT_DIR : null,
    databaseBytes: database,
    files: { count: data.length, bytes: size(data) },
    project: project ? { count: project.items.length, bytes: size(project.items), skippedBackups: project.skippedBackups } : null
  }
}

async function sha256File(file: string) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

/** Already-compressed files are stored as they are (faster, and zipping them saves nothing). */
const STORED = /\.(jpe?g|png|webp|gif|heic|mp4|mov|webm|m4v|3gp|zip|gz|pdf|dump)$/i

const stamp = (d = new Date()) => {
  const p = localParts(d)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${two(p.month)}-${two(p.day)}_${two(p.hour)}-${two(p.minute)}`
}

async function uniqueName(dir: string, base: string) {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.zip` : `${base}_${i}.zip`
    if (!fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(dir, `${name}.partial`))) return name
  }
}

/** Retries a rename that Windows refuses while a file is briefly open. */
async function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        await fsp.cp(from, to, { recursive: true })
        await fsp.rm(from, { recursive: true, force: true })
        return
      }
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
}

// ------------------------------------------------------------------------------------ zip reader

type EntryHandler = (entry: yauzl.Entry, open: () => Promise<Readable>) => Promise<void | 'stop'>

async function readZip(file: string, onEntry: EntryHandler) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, z) => (err || !z ? reject(err ?? new Error('Cannot open the file')) : resolve(z)))
  )
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', () => resolve())
      zip.on('entry', (entry: yauzl.Entry) => {
        const open = () => new Promise<Readable>((res, rej) => zip.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error('Cannot read the file')) : res(s))))
        onEntry(entry, open).then((r) => (r === 'stop' ? resolve() : zip.readEntry()), reject)
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

async function readManifest(file: string): Promise<Manifest> {
  let manifest: Manifest | null = null
  try {
    await readZip(file, async (entry, open) => {
      if (entry.fileName !== 'manifest.json') return
      if (entry.uncompressedSize > 20 * 1024 * 1024) throw new Error('manifest too large')
      const chunks: Buffer[] = []
      for await (const c of await open()) chunks.push(c as Buffer)
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Manifest
      return 'stop'
    })
  } catch (err) {
    throw new Error(`This is not a readable backup file (${(err as Error).message}).`)
  }
  const m = manifest as Manifest | null
  if (!m || m.format !== FORMAT) throw new Error('This file was not made by the Backup & Restore module (manifest.json is missing).')
  if (m.formatVersion > FORMAT_VERSION) throw new Error('This backup was made by a newer version of the software. Update the software first.')
  if (!m.checksums?.['database.dump']) throw new Error('This backup has no database in it.')
  return m
}

/**
 * Reads every entry and checks it against the manifest's checksums; with `extractTo`, also unpacks
 * it there. Fails on a missing, extra, changed or unsafe entry.
 */
async function verifyZip(file: string, manifest: Manifest, extractTo: string | null, onProgress: (bytes: number) => void) {
  const seen = new Set<string>()
  let done = 0
  await readZip(file, async (entry, open) => {
    const name = entry.fileName
    if (name.endsWith('/')) return
    if (name === 'manifest.json') return
    if (name.includes('\\') || name.split('/').some((p) => p === '..' || p === '') || path.isAbsolute(name)) throw new Error(`Unsafe file name in the backup: ${name}`)
    const expected = manifest.checksums[name]
    if (!expected) throw new Error(`Unexpected file in the backup: ${name}`)
    const hash = crypto.createHash('sha256')
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk)
        done += chunk.length
        onProgress(done)
        cb(null, chunk)
      }
    })
    // A restore unpacks the database and the uploaded files; project/ is checked, not unpacked.
    if (extractTo && (name === 'database.dump' || name.startsWith('files/'))) {
      const dest = path.join(extractTo, ...name.split('/'))
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await pipeline(await open(), hasher, fs.createWriteStream(dest))
    } else {
      await pipeline(await open(), hasher, new Writable({ write: (_c, _e, cb) => cb() }))
    }
    if (hash.digest('hex') !== expected) throw new Error(`The backup file is damaged: ${name} does not match its checksum.`)
    seen.add(name)
  })
  const missing = Object.keys(manifest.checksums).filter((n) => !seen.has(n))
  if (missing.length) throw new Error(`The backup file is incomplete: ${missing.length} file(s) missing, e.g. ${missing[0]}.`)
}

// ---------------------------------------------------------------------------------------- backup

async function publicTables(client: pg.Pool | pg.PoolClient): Promise<string[]> {
  const r = await client.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)
  return r.rows.map((x) => x.t)
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

/**
 * Makes a backup file in `folder`: a Full project backup, a Database only backup, or a DATA backup
 * (the safety backup before a restore). Steps "database", "files", "archive" and "verify" are
 * reported on the job. The app keeps running: nothing is paused or locked while a backup is made.
 */
async function writeBackup(job: Job, opts: { by: string; folder: string; kind: 'BACKUP' | 'SAFETY_BACKUP'; scope: BackupScope; range: [number, number] } & BackupOptions) {
  const [from, to] = opts.range
  const pct = (f: number) => (job.percent = Math.round(from + (to - from) * Math.min(1, Math.max(0, f))))
  const work = path.join(WORK_ROOT, `${job.id}-${opts.kind.toLowerCase()}`)
  await fsp.rm(work, { recursive: true, force: true })
  await fsp.mkdir(work, { recursive: true })
  await fsp.mkdir(opts.folder, { recursive: true })
  const base =
    opts.kind === 'SAFETY_BACKUP'
      ? `Safety_Backup_Before_Restore_${stamp()}`
      : opts.scope === 'PROJECT'
        ? `Full_Project_Backup_${stamp()}`
        : opts.scope === 'DATABASE'
          ? `Database_Backup_${stamp()}`
          : `Data_Backup_${stamp()}`
  const name = await uniqueName(opts.folder, base)
  const final = path.join(opts.folder, name)
  const partial = `${final}.partial`
  const key = opts.kind === 'SAFETY_BACKUP' ? 'safety' : null
  // A safety backup shows its progress as the detail of the one "safety" step.
  const mark = (k: string, s: Step['status'], d?: string) => (key ? step(job, key, 'running', s === 'running' ? `${labelFor(k)}…` : d) : step(job, k, s, d))

  try {
    // 1. Database
    mark('database', 'running')
    const dump = path.join(work, 'database.dump')
    await runTool('pg_dump', ['--format=custom', '--compress=6', '--no-password', `--file=${dump}`], liveDbName())
    const tables: Record<string, number> = {}
    for (const t of await publicTables(pool)) tables[t] = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(t)}`)).rows[0].n)
    const mig = await pool
      .query<{ n: string; last: string | null }>(`SELECT count(*) AS n, max(created_at)::text AS last FROM drizzle.__drizzle_migrations`)
      .then((r) => ({ count: Number(r.rows[0].n), lastCreatedAt: r.rows[0].last === null ? null : Number(r.rows[0].last) }))
      .catch(() => ({ count: 0, lastCreatedAt: null }))
    const serverVersion = (await pool.query<{ v: string }>('SHOW server_version')).rows[0].v
    const dumpBytes = (await fsp.stat(dump)).size
    const totalRows = Object.values(tables).reduce((a, b) => a + b, 0)
    mark('database', 'done', `${count(Object.keys(tables).length, 'table')}, ${count(totalRows, 'record')}`)
    pct(0.1)

    // 2. What goes in: the uploaded files (not for Database only) and, for a Full project backup, the project folder.
    const entries: { name: string; abs: string; size: number }[] = []
    const sets: Manifest['files'] = []
    let project: Manifest['project']
    if (opts.scope !== 'DATABASE') {
      mark('files', 'running')
      for (const set of fileSets()) {
        const items = await walk(set.dir, set.skip)
        for (const f of items) entries.push({ name: `files/${set.key}/${f.rel}`, abs: f.abs, size: f.size })
        sets.push({ key: set.key, label: set.label, count: items.length, bytes: items.reduce((a, b) => a + b.size, 0) })
      }
      if (opts.scope === 'PROJECT') {
        const found = await walkProject(opts)
        for (const f of found.items) entries.push({ name: `project/${f.rel}`, abs: f.abs, size: f.size })
        project = {
          root: path.basename(PROJECT_DIR),
          count: found.items.length,
          bytes: found.items.reduce((a, b) => a + b.size, 0),
          includesSecrets: !!opts.includeSecrets,
          includesPackages: !!opts.includePackages,
          skippedBackups: found.skippedBackups
        }
      }
      const dataFiles = sets.reduce((a, b) => a + b.count, 0)
      mark('files', 'done', project ? `${count(project.count, 'project file')}, ${formatBytes(project.bytes)} · ${dataFiles.toLocaleString('en-IN')} photos, videos and documents` : `${count(dataFiles, 'file')}`)
    }
    pct(0.2)

    // 3. The .zip (as .partial until checked). Each file is hashed as it is written; the manifest,
    //    with every checksum, goes in last.
    mark('archive', 'running')
    const checksums: Record<string, string> = {}
    const sizes: Record<string, number> = {}
    const missing: string[] = []
    const total = dumpBytes + entries.reduce((a, b) => a + b.size, 0) || 1
    let written = 0
    const out = fs.createWriteStream(partial)
    const archive = archiver('zip', { zlib: { level: 6 } })
    const failed = new Promise<never>((_, reject) => {
      archive.on('warning', reject)
      archive.on('error', reject)
      out.on('error', reject)
    })
    failed.catch(() => {})
    archive.pipe(out)
    const createdAt = new Date().toISOString()
    const guide = opts.scope === 'PROJECT' ? restoreGuide({ createdAt, by: opts.by, includesSecrets: !!opts.includeSecrets, includesPackages: !!opts.includePackages }) : null
    // One entry at a time: the next file is opened only when the zip has finished the one before
    // (so thousands of files never hold thousands of handles), and the manifest goes in last, when
    // every checksum is known.
    const queue: { name: string; abs: string }[] = [{ name: 'database.dump', abs: dump }, ...entries]
    let manifest: Manifest | null = null
    let next = 0
    let finished = false
    const feed = () => {
      if (next < queue.length) {
        const { name: entry, abs } = queue[next++]
        archive.append(
          new HashedFile(
            abs,
            (sha, bytes, gone) => {
              checksums[entry] = sha
              sizes[entry] = bytes
              if (gone) missing.push(entry)
            },
            (n) => pct(0.2 + 0.5 * ((written += n) / total))
          ),
          { name: entry, store: STORED.test(entry) } as archiver.EntryData
        )
        return
      }
      if (finished) return
      finished = true
      if (guide) {
        checksums['RESTORE.txt'] = crypto.createHash('sha256').update(guide).digest('hex')
        sizes['RESTORE.txt'] = Buffer.byteLength(guide)
        archive.append(guide, { name: 'RESTORE.txt' })
      }
      manifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        createdAt,
        createdBy: opts.by,
        kind: opts.kind,
        scope: opts.scope,
        app: { name: 'Quality Monitoring', version: appVersion },
        database: { name: liveDbName(), serverVersion, migrations: mig, tables, file: 'database.dump' },
        files: sets,
        checksums,
        sizes,
        passwordKeyFingerprint: passwordKeyFingerprint(),
        ...(project ? { project } : {}),
        ...(missing.length ? { missing } : {})
      }
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
      void archive.finalize()
    }
    archive.on('entry', () => {
      try {
        feed()
      } catch (err) {
        archive.emit('error', err)
      }
    })
    feed()
    await Promise.race([once(out, 'close'), failed])
    if (!manifest) throw new Error('The backup file could not be completed.')
    mark('archive', 'done', formatBytes((await fsp.stat(partial)).size))
    pct(0.7)

    // 4. Read it all back before calling it a backup.
    mark('verify', 'running')
    await verifyZip(partial, manifest, null, (b) => pct(0.7 + 0.3 * (b / total)))
    await fsp.rename(partial, final)
    const bytes = (await fsp.stat(final)).size
    mark('verify', 'done', 'Every file checked')
    pct(1)
    return { name, folder: opts.folder, path: final, bytes, manifest: manifest as Manifest, dump }
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => {})
    throw err
  } finally {
    // The dump is kept for a safety backup (a failed restore is undone with it); removed with the job.
    if (opts.kind === 'BACKUP') await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** RESTORE.txt in a Full project backup: how to set the project up again from this file. */
function restoreGuide(m: { createdAt: string; by: string; includesSecrets: boolean; includesPackages: boolean }) {
  const db = liveDbName()
  const when = new Date(m.createdAt).toLocaleString('en-IN', { timeZone: config.plantTimezone })
  return [
    'Quality Monitoring - Full project backup',
    `Made ${when} by ${m.by}.`,
    '',
    'Inside this file',
    '  project/        the whole project folder: code, admin panel, worker app, launcher, settings, builds, scripts',
    '  files/          uploaded photos, videos and documents:',
    '                    files/uploads             -> backend/uploads',
    '                    files/calendar-documents  -> backend/calendar-documents',
    '                    files/report-outbox       -> backend/report-outbox',
    '  database.dump   the whole PostgreSQL database (pg_dump custom format)',
    '  manifest.json   what is inside, with a checksum of every file',
    m.includesSecrets
      ? '  NOTE: backend\\.env and the key files ARE included. Anyone with this file can read the database and email passwords: keep it safe.'
      : '  NOTE: backend\\.env and the key files are NOT included. Copy backend\\.env.example to backend\\.env and fill it in.',
    m.includesPackages ? '' : '  Installed packages (node_modules) are not included: server.bat installs them on the first run.',
    '',
    'Set the project up on another computer',
    '  1. Install Node.js 22 or newer and PostgreSQL 18.',
    '  2. Unzip this file. Copy the "project" folder to where the project should live.',
    '  3. Copy the three folders under files/ into the project\'s backend folder, as listed above.',
    '  4. Create the database and load the dump (PostgreSQL bin folder, e.g. C:\\Program Files\\PostgreSQL\\18\\bin):',
    `       createdb -U postgres ${db}`,
    `       pg_restore -U postgres -d ${db} --no-owner database.dump`,
    '  5. Check backend\\.env: DATABASE_URL (password), and the server address if the computer changed.',
    '  6. Run server.bat. It installs the packages, builds the apps and starts the server.',
    '',
    'Or, instead of steps 3 and 4: start the server once on an empty database, sign in as Super Admin,',
    'open Backup & Restore > Restore, choose this file and "Restore everything". That restores the',
    'database and all the photos and documents in one go.',
    ''
  ]
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\r\n')
}

const labelFor = (k: string) =>
  ({ database: 'Exporting the database', files: 'Listing the files', archive: 'Writing the backup file', verify: 'Checking the backup file' })[k] ?? k

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** Starts a backup (Backup button). Resolves at once with the job; it runs in the background. */
export function startBackup(by: string, scope: BackupScope, options: BackupOptions, onFinish: (job: Job) => Promise<void>): Job {
  const opts: BackupOptions = scope === 'PROJECT' ? { includeSecrets: options.includeSecrets ?? true, includePackages: options.includePackages ?? false } : {}
  const title = scope === 'PROJECT' ? 'Full project backup' : scope === 'DATABASE' ? 'Database backup' : 'Backup'
  const job = newJob('BACKUP', title, by, [
    ['check', 'Checking the database tools'],
    ['database', 'Exporting the database (pg_dump)'],
    ...(scope === 'DATABASE' ? [] : ([['files', scope === 'PROJECT' ? 'Listing the project files, photos and documents' : 'Listing photos, videos and documents']] as [string, string][])),
    ['archive', 'Writing the backup file'],
    ['verify', 'Checking the backup file']
  ])
  void (async () => {
    const folder = backupLocation()
    let outcome: Job['status'] = 'failed'
    try {
      step(job, 'check', 'running')
      const tools = await toolStatus()
      if (!tools.ok) throw new Error(tools.error ?? 'The PostgreSQL tools are not available.')
      step(job, 'check', 'done', tools.version ?? undefined)
      const made = await writeBackup(job, { by, folder, kind: 'BACKUP', scope, range: [2, 100], ...opts })
      job.file = made.name
      job.result = { bytes: made.bytes }
      outcome = 'success'
      job.message = `Backup saved: ${made.name}`
      addHistory({ id: job.id, kind: 'BACKUP', scope, status: 'SUCCESS', startedAt: job.startedAt, finishedAt: new Date().toISOString(), by, file: made.name, folder, bytes: made.bytes, summary: summaryOf(made.manifest) })
    } catch (err) {
      failJob(job, err)
      addHistory({ id: job.id, kind: 'BACKUP', scope, status: 'FAILED', startedAt: job.startedAt, finishedAt: new Date().toISOString(), by, folder, error: job.error ?? undefined })
    } finally {
      settle(job, outcome)
      await onFinish(job).catch((e) => console.error('[Backup] audit failed', e))
    }
  })()
  return job
}

/** "1 file", "2 files". */
const count = (n: number, word: string) => `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`

function summaryOf(m: Manifest) {
  const rows = Object.values(m.database.tables).reduce((a, b) => a + b, 0)
  const files = m.files.reduce((a, b) => a + b.count, 0)
  const scope = scopeOf(m)
  if (scope === 'DATABASE') return `${count(rows, 'record')} (database only)`
  if (scope === 'PROJECT') return `${count(rows, 'record')}, ${count(files, 'file')}, ${count(m.project?.count ?? 0, 'project file')}`
  return `${count(rows, 'record')}, ${count(files, 'file')}`
}

/**
 * Ends a job: frees the lock first, then shows the final status, so whoever sees "finished" can
 * start the next job at once.
 */
function settle(job: Job, status: Job['status']) {
  job.finishedAt = new Date().toISOString()
  release(job)
  job.status = status
}

/** Records a job's error (the caller settles the job once it has cleaned up). */
function failJob(job: Job, err: unknown) {
  job.error = clean((err as Error)?.message ?? String(err))
  const running = job.steps.find((s) => s.status === 'running')
  if (running) running.status = 'failed'
  job.message = null
  console.error(`[Backup] ${job.title} failed:`, job.error)
}

// -------------------------------------------------------------------------------- backup listing

export interface BackupFile {
  name: string
  folder: string
  bytes: number
  createdAt: string
  createdBy: string | null
  kind: 'BACKUP' | 'SAFETY_BACKUP' | null
  scope: BackupScope | null
  summary: string | null
  appVersion: string | null
  valid: boolean
  error: string | null
}

const manifestCache = new Map<string, { mtime: number; manifest: Manifest | null; error: string | null }>()

export async function listBackups(): Promise<BackupFile[]> {
  const folders = [...new Set([backupLocation(), DEFAULT_BACKUP_DIR])]
  const out: BackupFile[] = []
  for (const folder of folders) {
    let names: string[] = []
    try {
      names = (await fsp.readdir(folder)).filter((n) => n.toLowerCase().endsWith('.zip'))
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(folder, name)
      const st = await fsp.stat(file).catch(() => null)
      if (!st?.isFile()) continue
      let cached = manifestCache.get(file)
      if (!cached || cached.mtime !== st.mtimeMs) {
        try {
          cached = { mtime: st.mtimeMs, manifest: await readManifest(file), error: null }
        } catch (err) {
          cached = { mtime: st.mtimeMs, manifest: null, error: (err as Error).message }
        }
        manifestCache.set(file, cached)
      }
      const m = cached.manifest
      out.push({
        name,
        folder,
        bytes: st.size,
        createdAt: m?.createdAt ?? st.mtime.toISOString(),
        createdBy: m?.createdBy ?? null,
        kind: m?.kind ?? null,
        scope: m ? scopeOf(m) : null,
        summary: m ? summaryOf(m) : null,
        appVersion: m?.app.version ?? null,
        valid: !!m,
        error: cached.error
      })
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const history = () => readState().history

/** A backup file by name, from the backup folders only (never any other path). */
export function resolveBackupFile(name: string): string | null {
  if (!/^[\w.\- ()]+\.zip$/i.test(name) || name.includes('..')) return null
  for (const folder of new Set([backupLocation(), DEFAULT_BACKUP_DIR])) {
    const file = path.join(folder, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

// One-time download links, so a large file downloads straight to disk (no token in the address).
const tickets = new Map<string, { file: string; expires: number }>()
export function downloadTicket(file: string) {
  const id = crypto.randomBytes(24).toString('hex')
  tickets.set(id, { file, expires: Date.now() + 60_000 })
  return id
}
export function useTicket(id: string): string | null {
  const t = tickets.get(id)
  tickets.delete(id)
  for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k)
  return t && t.expires >= Date.now() ? t.file : null
}

// ---------------------------------------------------------------------------- restore: analysis

function stagePool() {
  // Raw text for every value: rows are copied as PostgreSQL wrote them (dates, JSON, arrays…).
  return new pg.Pool({ connectionString: dbUrl(stageDbName()).toString(), max: 2, types: { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig })
}

async function adminQuery(sql: string) {
  const client = new pg.Client({ connectionString: dbUrl('postgres').toString() })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

const dropStage = () => adminQuery(`DROP DATABASE IF EXISTS ${q(stageDbName())} WITH (FORCE)`)

/** Starts checking a backup file for a restore: unpacks, verifies, loads and compares it. */
export function startRestoreAnalysis(by: string, zip: string, uploaded: boolean, displayName: string): Job {
  const job = newJob('RESTORE', 'Restore', by, [
    ['read', 'Reading the backup file'],
    ['verify', 'Checking every file in the backup'],
    ['database', 'Loading the backup into a temporary database'],
    ['upgrade', 'Bringing it up to this software version'],
    ['compare', 'Looking for data that already exists'],
    ['safety', 'Safety backup of the current data'],
    ['restore-db', 'Restoring the database'],
    ['restore-files', 'Restoring photos, videos and documents']
  ])
  job.file = displayName
  const work = path.join(WORK_ROOT, job.id)
  const internal: Internal = { work, zip, uploaded, manifest: null, expiry: null }
  internals.set(job.id, internal)
  void (async () => {
    try {
      await fsp.rm(work, { recursive: true, force: true })
      await fsp.mkdir(work, { recursive: true })

      step(job, 'read', 'running')
      const tools = await toolStatus()
      if (!tools.ok) throw new Error(tools.error ?? 'The PostgreSQL tools are not available.')
      const manifest = await readManifest(zip)
      internal.manifest = manifest
      const local = localMigrations()
      if (manifest.database.migrations.lastCreatedAt && manifest.database.migrations.lastCreatedAt > local.last) {
        throw new Error('This backup was made by a newer version of the software. Update the software on this server first, then restore.')
      }
      step(job, 'read', 'done', `Made ${new Date(manifest.createdAt).toLocaleString('en-IN', { timeZone: config.plantTimezone })} by ${manifest.createdBy}`)
      job.percent = 5

      step(job, 'verify', 'running')
      const total = Object.values(manifest.sizes ?? {}).reduce((a, b) => a + b, 0) || 1
      await verifyZip(zip, manifest, path.join(work, 'extract'), (b) => (job.percent = Math.round(5 + 35 * (b / total))))
      step(job, 'verify', 'done', `${count(Object.keys(manifest.checksums).length, 'file')} checked`)

      step(job, 'database', 'running')
      const dump = path.join(work, 'extract', 'database.dump')
      await runTool('pg_restore', ['--list', dump], liveDbName())
      await dropStage()
      await adminQuery(`CREATE DATABASE ${q(stageDbName())}`)
      await runTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${stageDbName()}`, dump], stageDbName())
      step(job, 'database', 'done')
      job.percent = 60

      step(job, 'upgrade', 'running')
      const stage = stagePool()
      try {
        const found = await stage.query(`SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN 'no' ELSE 'yes' END AS ok`)
        if (found.rows[0].ok !== 'yes') throw new Error('The backup database is not a Quality Monitoring database.')
        const before = Number((await stage.query(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).rows[0].n)
        // The same migrations the server runs at start (on a normal connection).
        const upgrade = new pg.Pool({ connectionString: dbUrl(stageDbName()).toString(), max: 1 })
        try {
          await migrate(drizzle(upgrade), { migrationsFolder: MIGRATIONS_DIR })
        } finally {
          await upgrade.end()
        }
        const after = Number((await stage.query(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).rows[0].n)
        step(job, 'upgrade', 'done', after > before ? `${after - before} update(s) applied` : 'Already this version')
        job.percent = 70

        step(job, 'compare', 'running')
        job.analysis = await compare(stage, manifest, work, zip, displayName, after > before)
        step(job, 'compare', 'done', job.analysis.duplicates ? 'Data that already exists was found' : 'No existing data found')
      } finally {
        await stage.end()
      }
      job.percent = 100
      job.status = 'awaiting-choice'
      job.message = 'Choose how to restore'
      // A choice not made within 30 minutes cancels the restore and frees the server.
      internal.expiry = setTimeout(() => void cancelRestore(job.id), 30 * 60_000)
    } catch (err) {
      failJob(job, err)
      await cleanupRestore(job.id)
      settle(job, 'failed')
    }
  })()
  return job
}

async function compare(stage: pg.Pool, manifest: Manifest, work: string, zip: string, displayName: string, upgraded: boolean): Promise<Analysis> {
  const tables: TableComparison[] = []
  const stageTables = new Set(await publicTables(stage))
  const live = await pool.connect()
  try {
    for (const t of await publicTables(live)) {
      const pk = await primaryKey(live, t)
      const liveRows = Number((await live.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(t)}`)).rows[0].n)
      if (!stageTables.has(t)) {
        tables.push({ table: t, backupRows: 0, liveRows, sameId: 0, identical: 0, different: 0, newRows: 0 })
        continue
      }
      const key = pk.length ? `row(${pk.map((c) => `x.${q(c)}`).join(', ')})::text` : `md5(x::text)`
      const sql = `SELECT ${key} AS k, md5(x::text) AS h FROM ${q(t)} x`
      const liveMap = new Map((await live.query<{ k: string; h: string }>(sql)).rows.map((r) => [r.k, r.h]))
      const rows = (await stage.query<{ k: string; h: string }>(sql)).rows
      let sameId = 0
      let identical = 0
      for (const r of rows) {
        const h = liveMap.get(r.k)
        if (h === undefined) continue
        sameId++
        if (h === r.h) identical++
      }
      tables.push({ table: t, backupRows: rows.length, liveRows, sameId, identical, different: sameId - identical, newRows: rows.length - sameId })
    }
  } finally {
    live.release()
  }

  const scope = scopeOf(manifest)
  const notes: string[] = []
  if (scope === 'DATABASE') notes.push('This backup holds the database only. Photos, videos and documents are left exactly as they are, whichever option you choose.')
  if (scope === 'PROJECT') {
    notes.push('This is a Full project backup. Restoring here brings back the database and the photos, videos and documents. The project files (code, apps, settings) are not changed here; to set the project up on another computer, unzip the file and follow RESTORE.txt inside it.')
  }
  const files: FileComparison[] = []
  for (const set of scope === 'DATABASE' ? [] : fileSets()) {
    const prefix = `files/${set.key}/`
    const names = Object.keys(manifest.checksums).filter((n) => n.startsWith(prefix))
    const liveItems = await walk(set.dir, set.skip)
    const liveByRel = new Map(liveItems.map((f) => [f.rel, f]))
    let existing = 0
    let identical = 0
    let bytes = 0
    for (const n of names) {
      const rel = n.slice(prefix.length)
      bytes += manifest.sizes?.[n] ?? 0
      const lf = liveByRel.get(rel)
      if (!lf) continue
      existing++
      if (lf.size === (manifest.sizes?.[n] ?? -1) && (await sha256File(lf.abs)) === manifest.checksums[n]) identical++
    }
    const inBackup = new Set(names.map((n) => n.slice(prefix.length)))
    files.push({
      key: set.key,
      label: set.label,
      backupFiles: names.length,
      backupBytes: bytes,
      existing,
      identical,
      different: existing - identical,
      newFiles: names.length - existing,
      liveOnly: liveItems.filter((f) => !inBackup.has(f.rel)).length
    })
  }

  const warnings: string[] = []
  if (upgraded) warnings.push('This backup was made by an older version of the software. Its data was upgraded to this version for the restore.')
  const key = passwordKeyFingerprint()
  if (manifest.passwordKeyFingerprint && key && manifest.passwordKeyFingerprint !== key) {
    warnings.push('This backup comes from another server. Passwords still work for signing in, but saved passwords cannot be shown ("view password") until they are reset.')
  }
  const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((a, b) => a + f(b), 0)
  const totals = {
    backupRows: sum(tables, (t) => t.backupRows),
    sameId: sum(tables, (t) => t.sameId),
    different: sum(tables, (t) => t.different),
    newRows: sum(tables, (t) => t.newRows),
    backupFiles: sum(files, (f) => f.backupFiles),
    existingFiles: sum(files, (f) => f.existing),
    newFiles: sum(files, (f) => f.newFiles)
  }
  return {
    backup: { file: displayName, createdAt: manifest.createdAt, createdBy: manifest.createdBy, appVersion: manifest.app.version, kind: manifest.kind, scope, bytes: (await fsp.stat(zip)).size },
    notes,
    tables,
    files,
    totals,
    duplicates: totals.sameId > 0 || totals.existingFiles > 0,
    warnings
  }
}

async function primaryKey(client: pg.Pool | pg.PoolClient, table: string): Promise<string[]> {
  const r = await client.query<{ c: string }>(
    `SELECT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    [`public.${q(table)}`]
  )
  return r.rows.map((x) => x.c)
}

// ------------------------------------------------------------------------------- restore: apply

export async function cancelRestore(id: string) {
  const job = jobs.get(id)
  if (!job || job.status !== 'awaiting-choice') return false
  job.status = 'running'
  job.message = 'Restore cancelled. Nothing was changed.'
  for (const s of job.steps) if (s.status === 'pending') s.status = 'skipped'
  await cleanupRestore(id)
  settle(job, 'cancelled')
  return true
}

async function cleanupRestore(id: string) {
  const internal = internals.get(id)
  if (!internal) return
  if (internal.expiry) clearTimeout(internal.expiry)
  await dropStage().catch((e) => console.error('[Backup] could not remove the temporary database', clean(String(e))))
  await fsp.rm(internal.work, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(path.join(WORK_ROOT, `${id}-safety_backup`), { recursive: true, force: true }).catch(() => {})
  if (internal.uploaded && internal.zip) await fsp.rm(internal.zip, { force: true }).catch(() => {})
  internals.delete(id)
}

/** Restores the analysed backup with the chosen mode (runs in the background). */
export function applyRestore(id: string, mode: RestoreMode, by: string, onFinish: (job: Job) => Promise<void>): Job {
  const job = jobs.get(id)
  const internal = internals.get(id)
  if (!job || !internal?.manifest || job.status !== 'awaiting-choice') throw new Error('This restore is no longer waiting for a choice. Start it again.')
  if (internal.expiry) clearTimeout(internal.expiry)
  job.status = 'running'
  job.mode = mode
  job.percent = 0
  job.message = null
  void (async () => {
    let outcome: Job['status'] = 'failed'
    let safety: Awaited<ReturnType<typeof writeBackup>> | null = null
    const folder = backupLocation()
    try {
      maintenance = true
      step(job, 'safety', 'running')
      safety = await writeBackup(job, { by: `${by} (automatic, before restore)`, folder, kind: 'SAFETY_BACKUP', scope: 'DATA', range: [0, 45] })
      step(job, 'safety', 'done', safety.name)
      addHistory({ id: crypto.randomUUID(), kind: 'SAFETY_BACKUP', scope: 'DATA', status: 'SUCCESS', startedAt: job.startedAt, finishedAt: new Date().toISOString(), by, file: safety.name, folder, bytes: safety.bytes, summary: summaryOf(safety.manifest) })
      job.result = { safetyBackup: safety.name }

      const extract = path.join(internal.work, 'extract')
      const databaseOnly = scopeOf(internal.manifest!) === 'DATABASE'
      if (mode === 'FULL') {
        step(job, 'restore-db', 'running')
        const staged = path.join(internal.work, 'staged.dump')
        await runTool('pg_dump', ['--format=custom', '--no-password', `--file=${staged}`], stageDbName())
        await replaceDatabase(staged, internal.work)
        step(job, 'restore-db', 'done', 'The database is now the backup')
        job.percent = 75

        step(job, 'restore-files', 'running')
        if (databaseOnly) {
          step(job, 'restore-files', 'skipped', 'Database-only backup: photos, videos and documents were left as they are')
        } else {
          try {
            const n = await swapFolders(extract)
            step(job, 'restore-files', 'done', count(n, 'file'))
            job.result = { ...job.result, files: { copied: n, skipped: 0, failed: 0 } }
          } catch (err) {
            // Put the database back as it was, so files and records still belong together.
            step(job, 'restore-files', 'failed', clean((err as Error).message))
            await replaceDatabase(safety.dump, internal.work).catch((e) => {
              throw new Error(`Restoring the files failed (${(err as Error).message}) and the database could not be put back automatically (${(e as Error).message}). Restore the safety backup ${safety!.name}.`)
            })
            throw new Error(`Restoring the files failed, so nothing was changed (the database was put back): ${(err as Error).message}`)
          }
        }
      } else {
        step(job, 'restore-db', 'running')
        const stage = stagePool()
        try {
          const tables = await mergeDatabase(stage, mode, (f) => (job.percent = Math.round(45 + 35 * f)))
          job.result = { ...job.result, tables }
          const added = tables.reduce((a, t) => a + t.added, 0)
          const updated = tables.reduce((a, t) => a + t.updated, 0)
          const failed = tables.reduce((a, t) => a + t.failed, 0)
          step(job, 'restore-db', 'done', `${added.toLocaleString('en-IN')} added${mode === 'REPLACE' ? `, ${updated.toLocaleString('en-IN')} replaced` : ''}${failed ? `, ${failed} not restored` : ''}`)
        } finally {
          await stage.end()
        }
        step(job, 'restore-files', 'running')
        const files = await mergeFiles(extract, internal.manifest!, mode)
        job.result = { ...job.result, files }
        if (databaseOnly) step(job, 'restore-files', 'skipped', 'Database-only backup: photos, videos and documents were left as they are')
        else step(job, 'restore-files', 'done', `${files.copied.toLocaleString('en-IN')} copied, ${files.skipped.toLocaleString('en-IN')} kept as they were${files.failed ? `, ${files.failed} failed` : ''}`)
      }
      job.percent = 100
      outcome = 'success'
      job.message =
        mode === 'FULL' ? (databaseOnly ? 'The database now matches the backup. Photos and documents were not changed.' : 'The data now matches the backup.') : 'The backup was merged into the current data.'
      addHistory({ id: job.id, kind: 'RESTORE', status: 'SUCCESS', startedAt: job.startedAt, finishedAt: new Date().toISOString(), by, file: job.file ?? undefined, mode, summary: restoreSummary(job) })
    } catch (err) {
      failJob(job, err)
      addHistory({ id: job.id, kind: 'RESTORE', status: 'FAILED', startedAt: job.startedAt, finishedAt: new Date().toISOString(), by, file: job.file ?? undefined, mode, error: job.error ?? undefined, summary: safety ? `Safety backup: ${safety.name}` : undefined })
    } finally {
      maintenance = false
      for (const s of job.steps) if (s.status === 'pending') s.status = 'skipped'
      await cleanupRestore(id)
      settle(job, outcome)
      await onFinish(job).catch((e) => console.error('[Backup] audit failed', e))
    }
  })()
  return job
}

function restoreSummary(job: Job) {
  const t = job.result?.tables
  const f = job.result?.files
  if (job.mode === 'FULL') return `Full restore${f ? `, ${count(f.copied, 'file')}` : ''}`
  const added = t?.reduce((a, x) => a + x.added, 0) ?? 0
  const updated = t?.reduce((a, x) => a + x.updated, 0) ?? 0
  return `${count(added, 'record')} added${job.mode === 'REPLACE' ? `, ${updated.toLocaleString('en-IN')} replaced` : ''}, ${count(f?.copied ?? 0, 'file')} copied`
}

/**
 * Makes the live database exactly the given dump, in one transaction: the old tables are dropped
 * and the dump loaded; any error rolls everything back and the old data stays.
 */
async function replaceDatabase(dump: string, work: string) {
  const sql = path.join(work, `restore-${Date.now()}.sql`)
  const pre = path.join(work, `restore-${Date.now()}-pre.sql`)
  await runTool('pg_restore', ['--no-owner', '--no-privileges', `--file=${sql}`, dump], liveDbName())
  await fsp.writeFile(
    pre,
    [
      "SET lock_timeout = '60s';",
      'DROP SCHEMA IF EXISTS drizzle CASCADE;',
      'DROP SCHEMA public CASCADE;',
      'CREATE SCHEMA public;',
      'GRANT USAGE ON SCHEMA public TO PUBLIC;',
      ''
    ].join('\n')
  )
  try {
    await runTool('psql', ['--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', '--single-transaction', `--file=${pre}`, `--file=${sql}`], liveDbName())
  } finally {
    await fsp.rm(sql, { force: true }).catch(() => {})
    await fsp.rm(pre, { force: true }).catch(() => {})
  }
}

/** Full restore of the files: each folder is swapped for the backup's; undone if any swap fails. */
async function swapFolders(extract: string): Promise<number> {
  const tag = `.before-restore-${Date.now()}`
  const swapped: { dir: string; old: string | null }[] = []
  let count = 0
  try {
    for (const set of fileSets()) {
      const src = path.join(extract, 'files', set.key)
      await fsp.mkdir(src, { recursive: true })
      count += (await walk(src, new Set())).length
      const old = fs.existsSync(set.dir) ? `${set.dir}${tag}` : null
      if (old) await renameRetry(set.dir, old)
      swapped.push({ dir: set.dir, old })
      await fsp.mkdir(path.dirname(set.dir), { recursive: true })
      await renameRetry(src, set.dir)
      // Uploads in progress keep their temporary folder.
      for (const skipped of set.skip) {
        const from = old ? path.join(old, skipped) : null
        if (from && fs.existsSync(from)) await renameRetry(from, path.join(set.dir, skipped))
        else await fsp.mkdir(path.join(set.dir, skipped), { recursive: true })
      }
    }
  } catch (err) {
    for (const s of swapped.reverse()) {
      await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {})
      if (s.old) await renameRetry(s.old, s.dir).catch(() => {})
    }
    throw err
  }
  for (const s of swapped) if (s.old) await fsp.rm(s.old, { recursive: true, force: true }).catch(() => {})
  return count
}

/** Skip / Replace restore of the files: copies the backup's files next to the current ones. */
async function mergeFiles(extract: string, manifest: Manifest, mode: RestoreMode) {
  let copied = 0
  let skipped = 0
  let failed = 0
  for (const set of fileSets()) {
    const prefix = `files/${set.key}/`
    for (const name of Object.keys(manifest.checksums).filter((n) => n.startsWith(prefix))) {
      const rel = name.slice(prefix.length)
      const src = path.join(extract, ...name.split('/'))
      const dest = path.join(set.dir, ...rel.split('/'))
      try {
        if (fs.existsSync(dest)) {
          const same = (await fsp.stat(dest)).size === manifest.sizes?.[name] && (await sha256File(dest)) === manifest.checksums[name]
          if (same || mode === 'SKIP') {
            skipped++
            continue
          }
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.copyFile(src, dest)
        copied++
      } catch (err) {
        failed++
        console.error(`[Backup] could not restore ${name}:`, (err as Error).message)
      }
    }
  }
  return { copied, skipped, failed }
}

/**
 * Skip / Replace restore of the records, in one transaction on the live database. Tables are
 * filled parents first (by their foreign keys). A record that cannot be added (e.g. its parent was
 * kept out) is tried again after the others, then reported; everything else still goes in.
 */
async function mergeDatabase(stage: pg.Pool, mode: RestoreMode, progress: (f: number) => void): Promise<TableResult[]> {
  const live = await pool.connect()
  const results: TableResult[] = []
  try {
    await live.query('BEGIN')
    await live.query(`SET LOCAL lock_timeout = '60s'`)
    const tables = await publicTables(live)
    const stageTables = new Set(await publicTables(stage))
    const order = await parentsFirst(live, tables)
    type Pending = { table: string; sql: string; values: unknown[]; existed: boolean; error: string }
    let pending: Pending[] = []
    let sp = 0
    let i = 0
    for (const t of order) {
      progress(i++ / order.length)
      const result: TableResult = { table: t, added: 0, updated: 0, unchanged: 0, failed: 0, errors: [] }
      results.push(result)
      if (!stageTables.has(t)) continue
      const pk = await primaryKey(live, t)
      const liveCols = await columns(live, t)
      const stageCols = new Set(await columns(stage, t))
      const cols = liveCols.filter((c) => stageCols.has(c))
      if (!cols.length || !pk.length || pk.some((c) => !cols.includes(c))) continue
      const other = cols.filter((c) => !pk.includes(c))
      const keyOf = (row: unknown[]) => JSON.stringify(pk.map((c) => row[cols.indexOf(c)]))
      const existing = new Set(
        (await live.query({ text: `SELECT ${pk.map((c) => `${q(c)}::text`).join(', ')} FROM ${q(t)}`, rowMode: 'array' })).rows.map((r: unknown[]) => JSON.stringify(r))
      )
      const conflict =
        mode === 'REPLACE' && other.length
          ? `ON CONFLICT (${pk.map(q).join(', ')}) DO UPDATE SET ${other.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')} WHERE (${other.map((c) => `${q(t)}.${q(c)}`).join(', ')}${other.length === 1 ? ', NULL' : ''}) IS DISTINCT FROM (${other.map((c) => `EXCLUDED.${q(c)}`).join(', ')}${other.length === 1 ? ', NULL' : ''})`
          : mode === 'REPLACE'
            ? `ON CONFLICT (${pk.map(q).join(', ')}) DO NOTHING`
            : 'ON CONFLICT DO NOTHING'
      const rows = (await stage.query({ text: `SELECT ${cols.map(q).join(', ')} FROM ${q(t)} ORDER BY ${pk.map(q).join(', ')}`, rowMode: 'array' })).rows as unknown[][]
      const insert = (batch: unknown[][]) => {
        const values: unknown[] = []
        const tuples = batch.map((row) => `(${row.map((v) => (values.push(v), `$${values.length}`)).join(', ')})`)
        return { sql: `INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')} ${conflict}`, values }
      }
      const count = (batch: unknown[][], changed: number) => {
        const added = batch.filter((r) => !existing.has(keyOf(r))).length
        if (mode === 'SKIP') {
          result.added += changed
          result.unchanged += batch.length - changed
        } else {
          result.added += added
          result.updated += changed - added
          result.unchanged += batch.length - changed
        }
      }
      const BATCH = Math.max(1, Math.floor(30000 / cols.length))
      for (let b = 0; b < rows.length; b += BATCH) {
        const batch = rows.slice(b, b + BATCH)
        const { sql, values } = insert(batch)
        const name = `sp${++sp}`
        await live.query(`SAVEPOINT ${name}`)
        try {
          const r = await live.query(sql, values)
          await live.query(`RELEASE SAVEPOINT ${name}`)
          count(batch, r.rowCount ?? 0)
        } catch {
          await live.query(`ROLLBACK TO SAVEPOINT ${name}`)
          // One record at a time, to find the ones that cannot go in.
          for (const row of batch) {
            const one = insert([row])
            const n = `sp${++sp}`
            await live.query(`SAVEPOINT ${n}`)
            try {
              const r = await live.query(one.sql, one.values)
              await live.query(`RELEASE SAVEPOINT ${n}`)
              count([row], r.rowCount ?? 0)
            } catch (err) {
              await live.query(`ROLLBACK TO SAVEPOINT ${n}`)
              pending.push({ table: t, sql: one.sql, values: one.values, existed: existing.has(keyOf(row)), error: (err as Error).message })
            }
          }
        }
      }
    }
    // Records whose parent came later: try again, a few rounds.
    for (let round = 0; round < 3 && pending.length; round++) {
      const next: Pending[] = []
      for (const p of pending) {
        const n = `sp${++sp}`
        await live.query(`SAVEPOINT ${n}`)
        try {
          const r = await live.query(p.sql, p.values)
          await live.query(`RELEASE SAVEPOINT ${n}`)
          const res = results.find((x) => x.table === p.table)!
          if ((r.rowCount ?? 0) === 0) res.unchanged++
          else if (p.existed) res.updated++
          else res.added++
        } catch (err) {
          await live.query(`ROLLBACK TO SAVEPOINT ${n}`)
          next.push({ ...p, error: (err as Error).message })
        }
      }
      if (next.length === pending.length) {
        pending = next
        break
      }
      pending = next
    }
    for (const p of pending) {
      const res = results.find((x) => x.table === p.table)!
      res.failed++
      if (res.errors.length < 5) res.errors.push(p.error)
    }
    await live.query('COMMIT')
    progress(1)
    return results.filter((r) => r.added || r.updated || r.unchanged || r.failed)
  } catch (err) {
    await live.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    live.release()
  }
}

async function columns(client: pg.Pool | pg.PoolClient, table: string): Promise<string[]> {
  const r = await client.query<{ c: string }>(
    `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    [table]
  )
  return r.rows.map((x) => x.c)
}

/** Tables ordered so a table comes after the tables its foreign keys point to. */
async function parentsFirst(client: pg.PoolClient, tables: string[]): Promise<string[]> {
  const r = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
     WHERE k.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public' AND k.conrelid <> k.confrelid`
  )
  const parents = new Map(tables.map((t) => [t, new Set<string>()]))
  for (const e of r.rows) parents.get(e.child)?.add(e.parent)
  const out: string[] = []
  const left = new Set(tables)
  while (left.size) {
    const ready = [...left].filter((t) => [...parents.get(t)!].every((p) => !left.has(p)))
    const next = ready.length ? ready : [[...left][0]]
    for (const t of next.sort()) {
      out.push(t)
      left.delete(t)
    }
  }
  return out
}

/** Removes work left behind by a server stopped in the middle of a job (at start-up). */
export async function cleanLeftovers() {
  await fsp.rm(WORK_ROOT, { recursive: true, force: true }).catch(() => {})
  await dropStage().catch(() => {})
  for (const folder of new Set([backupLocation(), DEFAULT_BACKUP_DIR])) {
    for (const n of await fsp.readdir(folder).catch(() => [] as string[])) {
      if (n.endsWith('.zip.partial')) await fsp.rm(path.join(folder, n), { force: true }).catch(() => {})
    }
  }
}
