import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  DatabaseBackup,
  Download,
  FileArchive,
  FolderOpen,
  FolderTree,
  History,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Upload,
  XCircle
} from 'lucide-react'
import { API_URL, ApiError, api, errorText, uploadWithProgress } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCountUp } from '../../lib/useCountUp'
import { formatBytes, formatDate, formatDateTime, formatTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { useToast } from '../../components/common/Toast'
import { Card, CardHeader, EmptyState } from '../../components/ui/Card'
import { Pill } from '../../components/ui/Chips'
import { StatCard } from '../../components/ui/StatCard'

// ------------------------------------------------------------------------------------------ types

type RestoreMode = 'SKIP' | 'REPLACE' | 'FULL'
/** PROJECT: whole project + database + files; DATABASE: database only; DATA: database + files (safety and older backups). */
type BackupScope = 'PROJECT' | 'DATABASE' | 'DATA'

const SCOPE_LABEL: Record<BackupScope, string> = { PROJECT: 'Full project', DATABASE: 'Database only', DATA: 'Database + files' }
const SCOPE_TONE: Record<BackupScope, string> = {
  PROJECT: 'bg-accent-soft text-accent-strong ring-accent-line',
  DATABASE: 'bg-subtle text-ink-secondary ring-line',
  DATA: 'bg-success-bg text-success ring-success-line'
}

interface Estimate {
  scope: BackupScope
  projectDir: string | null
  databaseBytes: number
  files: { count: number; bytes: number }
  project: { count: number; bytes: number; skippedBackups: number } | null
}

interface Step {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  detail?: string
}

interface TableComparison {
  table: string
  backupRows: number
  liveRows: number
  sameId: number
  identical: number
  different: number
  newRows: number
}

interface FileComparison {
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

interface Analysis {
  backup: { file: string; createdAt: string; createdBy: string; appVersion: string; kind: string; scope?: BackupScope; bytes: number }
  notes?: string[]
  tables: TableComparison[]
  files: FileComparison[]
  totals: { backupRows: number; sameId: number; different: number; newRows: number; backupFiles: number; existingFiles: number; newFiles: number }
  duplicates: boolean
  warnings: string[]
}

interface TableResult {
  table: string
  added: number
  updated: number
  unchanged: number
  failed: number
  errors: string[]
}

interface Job {
  id: string
  kind: 'BACKUP' | 'RESTORE'
  status: 'running' | 'awaiting-choice' | 'success' | 'failed' | 'cancelled'
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

interface BackupFile {
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

interface HistoryEntry {
  id: string
  kind: 'BACKUP' | 'SAFETY_BACKUP' | 'RESTORE'
  scope?: BackupScope
  status: 'SUCCESS' | 'FAILED'
  startedAt: string
  finishedAt: string
  by: string
  file?: string
  bytes?: number
  mode?: RestoreMode
  summary?: string
  error?: string
}

interface Overview {
  location: string
  defaultLocation: string
  tools: { ok: boolean; version: string | null; error: string | null }
  backups: BackupFile[]
  history: HistoryEntry[]
  lastBackup: HistoryEntry | null
  lastAttempt: HistoryEntry | null
  activeJob: Job | null
}

const MODE_LABEL: Record<RestoreMode, string> = { SKIP: 'Skip duplicates', REPLACE: 'Replace existing', FULL: 'Full restore' }
const n = (v: number) => v.toLocaleString('en-IN')
/** "1 record", "2 records". */
const count = (v: number, word: string) => `${n(v)} ${word}${v === 1 ? '' : 's'}`
const tableName = (t: string) => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

// ------------------------------------------------------------------------------------ job polling

/**
 * Follows a job until it stops running. The status address needs no sign-in, so it keeps working
 * while a restore pauses the API, and after a full restore that signs the user out.
 */
function useJob(id: string | null, nonce = 0) {
  const [job, setJob] = useState<Job | null>(null)
  useEffect(() => {
    if (!id) {
      setJob(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/backup-jobs/${id}`)
        if (res.ok) {
          const j = (await res.json()) as Job
          if (!alive) return
          setJob(j)
          if (j.status !== 'running') return
        }
      } catch {
        /* the server may be busy for a moment: try again */
      }
      if (alive) timer = setTimeout(poll, 700)
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [id, nonce])
  return job
}

// ----------------------------------------------------------------------------------------- pieces

/**
 * A step's icon. Keyed by its status, so a change plays once: a finished step's tick pops in, a
 * running one fades in.
 */
const StepIcon: React.FC<{ status: Step['status'] }> = ({ status }) => {
  const icon =
    status === 'done' ? (
      <CheckCircle2 className="w-4 h-4 text-success" aria-label="Done" />
    ) : status === 'running' ? (
      <Loader2 className="w-4 h-4 text-accent animate-spin" aria-label="In progress" />
    ) : status === 'failed' ? (
      <XCircle className="w-4 h-4 text-failed" aria-label="Failed" />
    ) : status === 'skipped' ? (
      <Ban className="w-4 h-4 text-ink-faint" aria-label="Skipped" />
    ) : (
      <Circle className="w-4 h-4 text-ink-faint" aria-label="Waiting" />
    )
  return (
    <span key={status} className={`relative z-10 shrink-0 rounded-full bg-white ${status === 'done' || status === 'failed' ? 'step-tick' : 'animate-fade-in'}`}>
      {icon}
    </span>
  )
}

/**
 * A progress bar: diagonal stripes move along it while the work runs, it turns green with one
 * sweep of light when done, red when it failed. The stripes stop for reduced motion.
 */
const ProgressBar: React.FC<{ percent: number; state: 'running' | 'success' | 'failed'; label?: string }> = ({ percent, state, label }) => (
  <div className="h-2.5 rounded-full bg-subtle overflow-hidden" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div
      className={`h-full rounded-full transition-[width,background-color] duration-500 ease-out ${
        state === 'failed' ? 'bg-[var(--color-chart-missed)]' : state === 'success' ? 'bg-[var(--color-chart-completed)] progress-shine' : 'bg-accent progress-stripes'
      }`}
      style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
    />
  </div>
)

/** A job's progress bar and steps. `only` limits the steps shown (the restore shows them in two parts). */
const JobProgress: React.FC<{ job: Job; only?: string[] }> = ({ job, only }) => {
  const steps = only ? job.steps.filter((s) => only.includes(s.key)) : job.steps
  const percent = useCountUp(job.percent)
  const finished = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const state = job.status === 'failed' || job.status === 'cancelled' ? 'failed' : job.status === 'running' ? 'running' : 'success'
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between text-[12.5px] mb-1.5">
          <span className="font-medium text-ink truncate">{job.status === 'running' ? (job.message ?? 'Working…') : (job.message ?? '')}</span>
          <span className="tabular-nums text-ink-muted shrink-0 ml-2">
            {steps.length > 1 && (
              <span className="mr-2 text-ink-faint">
                Step {Math.min(steps.length, finished + (state === 'running' ? 1 : 0))} of {steps.length}
              </span>
            )}
            {percent}%
          </span>
        </div>
        <ProgressBar percent={job.percent} state={state} />
      </div>
      <ol>
        {steps.map((s, i) => {
          const active = s.status === 'running'
          return (
            <li key={s.key} className="relative flex items-start gap-2.5 pb-2.5 last:pb-0">
              {/* The line to the next step fills in green once this one is finished. */}
              {i < steps.length - 1 && (
                <span className="absolute left-[7.5px] top-4 bottom-0 w-px bg-line overflow-hidden" aria-hidden>
                  <span
                    className={`block h-full w-full bg-[var(--color-chart-completed)] origin-top transition-transform duration-300 ease-out ${
                      s.status === 'done' || s.status === 'skipped' ? 'scale-y-100' : 'scale-y-0'
                    }`}
                  />
                </span>
              )}
              <StepIcon status={s.status} />
              <div className="min-w-0 -mt-px">
                <div
                  className={`text-[13px] transition-colors duration-200 ${
                    active ? 'text-accent-strong font-semibold' : s.status === 'pending' || s.status === 'skipped' ? 'text-ink-muted' : 'text-ink'
                  }`}
                >
                  {s.label}
                  {active && <span className="text-ink-muted font-normal">…</span>}
                </div>
                {s.detail && (
                  <div key={s.detail} className="text-[12px] text-ink-muted break-words animate-fade-in">
                    {s.detail}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const StatusPill: React.FC<{ status: 'SUCCESS' | 'FAILED' }> = ({ status }) =>
  status === 'SUCCESS' ? (
    <Pill className="bg-success-bg text-success ring-success-line">Success</Pill>
  ) : (
    <Pill className="bg-missed-bg text-failed ring-failed-line">Failed</Pill>
  )

// ------------------------------------------------------------------------------------------- page

/** Backup & Restore: complete backups of the database and every uploaded file. Super Admin only. */
export const BackupRestorePage: React.FC = () => {
  const notify = useToast()
  const { data, loading, error, reload } = useApi<Overview>('/api/system/backup/overview')
  const [backupJobId, setBackupJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [restore, setRestore] = useState<{ file?: string; jobId?: string } | null>(null)
  const backupJob = useJob(backupJobId)
  const announced = useRef<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // A backup started from another tab (or before this page opened) shows its progress here too.
  useEffect(() => {
    const active = data?.activeJob
    if (active?.kind === 'BACKUP' && active.status === 'running') setBackupJobId(active.id)
  }, [data?.activeJob])

  useEffect(() => {
    if (!backupJob || backupJob.status === 'running' || announced.current === backupJob.id) return
    announced.current = backupJob.id
    if (backupJob.status === 'success') {
      notify('success', 'Backup complete', `${backupJob.file} (${formatBytes(backupJob.result?.bytes ?? 0)})`)
      // The finished card (every step ticked, the bar green) stays a moment, then closes by itself.
      const id = backupJob.id
      clearTimeout(closeTimer.current)
      closeTimer.current = setTimeout(() => setBackupJobId((current) => (current === id ? null : current)), 3000)
    } else notify('error', 'Backup failed', backupJob.error ?? 'The backup could not be made.')
    void reload()
  }, [backupJob, notify, reload])
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  const startBackup = async (choice: { scope: BackupScope; includeSecrets?: boolean; includePackages?: boolean }) => {
    setStarting(true)
    try {
      const job = await api.post<Job>('/api/system/backup/backups', choice)
      setBackupJobId(job.id)
      setChoosing(false)
    } catch (err) {
      notify('error', 'Backup not started', errorText(err))
    } finally {
      setStarting(false)
    }
  }

  const download = async (file: BackupFile) => {
    try {
      const { url } = await api.post<{ url: string }>(`/api/system/backup/backups/${encodeURIComponent(file.name)}/download-link`)
      // A one-time link: the file goes straight to the Downloads folder, however large.
      const a = document.createElement('a')
      a.href = `${API_URL}${url}`
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      notify('error', 'Download failed', errorText(err))
    }
  }

  const busy = backupJob?.status === 'running' || starting
  const waitingRestore = data?.activeJob?.kind === 'RESTORE' && data.activeJob.status === 'awaiting-choice' ? data.activeJob : null
  const runningRestore = data?.activeJob?.kind === 'RESTORE' && data.activeJob.status === 'running' ? data.activeJob : null
  const totalBytes = data?.backups.reduce((a, b) => a + b.bytes, 0) ?? 0
  const lastRestore = data?.history.find((h) => h.kind === 'RESTORE') ?? null
  const failedLast = data?.lastAttempt?.status === 'FAILED' ? data.lastAttempt : null

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<DatabaseBackup className="w-4.5 h-4.5" />}
        title="Backup & Restore"
        description="Full project backups (code + database) and database-only backups"
        info="Full project: one .zip with the whole project folder (code, admin panel, worker app, launcher, settings, builds), the PostgreSQL database and every uploaded photo, video and document. Database only: the PostgreSQL database (tables, records, relationships, indexes, sequences). Only the Super Admin can see this page or use these actions."
        actions={
          <>
            <Button variant="outline" icon={<RotateCcw className="w-4 h-4" />} onClick={() => setRestore({})} disabled={!data || busy || !!runningRestore}>
              Restore
            </Button>
            <Button variant="primary" icon={<DatabaseBackup className="w-4 h-4" />} onClick={() => setChoosing(true)} loading={busy} disabled={!data?.tools.ok || !!data?.activeJob}>
              {busy ? 'Backing up…' : 'Backup'}
            </Button>
          </>
        }
      />

      <DataState loading={loading && !data} error={data ? null : error} onRetry={reload}>
        {data && (
          <>
            {!data.tools.ok && (
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg border border-failed-line bg-missed-bg text-[13px] text-failed" role="alert">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                <div>
                  <div className="font-semibold">Backups cannot run on this server</div>
                  <div>{data.tools.error}</div>
                </div>
              </div>
            )}

            {waitingRestore && !restore && (
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg border border-due-line bg-due-bg text-[13px] text-ink">
                <RotateCcw className="w-4 h-4 text-due shrink-0" aria-hidden />
                <span className="flex-1 min-w-[200px]">
                  A restore of <span className="font-medium">{waitingRestore.file}</span> is waiting for a choice. Nothing has been changed yet.
                </span>
                <Button size="sm" variant="primary" onClick={() => setRestore({ jobId: waitingRestore.id })}>
                  Continue
                </Button>
              </div>
            )}
            {runningRestore && !restore && (
              <Card padded>
                <CardHeader className="!px-0 !pt-0" icon={<RotateCcw className="w-4 h-4" />} title={`Restoring ${runningRestore.file ?? ''}`} />
                <JobProgress job={runningRestore} />
              </Card>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <StatCard
                label="Last backup"
                icon={<DatabaseBackup className="w-4 h-4" />}
                tone={data.lastBackup ? 'success' : 'neutral'}
                value={data.lastBackup ? formatDate(data.lastBackup.finishedAt) : 'Never'}
                meta={
                  data.lastBackup
                    ? `${formatTime(data.lastBackup.finishedAt)} · ${data.lastBackup.summary ?? ''}${data.lastBackup.bytes ? ` · ${formatBytes(data.lastBackup.bytes)}` : ''}`
                    : 'Click Backup to make the first one'
                }
              />
              <StatCard
                label="Backup status"
                icon={failedLast ? <XCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                tone={failedLast ? 'missed' : data.lastAttempt ? 'success' : 'neutral'}
                alert={!!failedLast}
                value={failedLast ? 'Failed' : data.lastAttempt ? 'Success' : '—'}
                meta={failedLast ? (failedLast.error ?? 'The last backup failed') : data.lastAttempt ? `Last attempt ${formatDateTime(data.lastAttempt.finishedAt)}` : 'No backups yet'}
              />
              <StatCard label="Backups stored" icon={<FileArchive className="w-4 h-4" />} value={String(data.backups.length)} meta={`${formatBytes(totalBytes)} in total`} />
              <StatCard
                label="Last restore"
                icon={<RotateCcw className="w-4 h-4" />}
                tone={lastRestore?.status === 'FAILED' ? 'missed' : 'neutral'}
                value={lastRestore ? formatDate(lastRestore.finishedAt) : 'Never'}
                meta={lastRestore ? `${formatTime(lastRestore.finishedAt)} · ${lastRestore.mode ? MODE_LABEL[lastRestore.mode] : 'Restore'} · ${lastRestore.status === 'SUCCESS' ? 'Success' : 'Failed'}` : 'No restores yet'}
              />
            </div>

            {backupJob && (
              <Card padded>
                <CardHeader
                  className="!px-0 !pt-0"
                  icon={<DatabaseBackup className="w-4 h-4" />}
                  title={backupJob.status === 'running' ? 'Backing up…' : backupJob.status === 'success' ? 'Backup complete' : 'Backup failed'}
                  subtitle={backupJob.status === 'running' ? 'You can keep working; the app stays available during a backup.' : undefined}
                  actions={
                    backupJob.status !== 'running' ? (
                      <Button size="sm" variant="ghost" onClick={() => setBackupJobId(null)}>
                        Dismiss
                      </Button>
                    ) : undefined
                  }
                />
                <JobProgress job={backupJob} />
                {backupJob.error && <FormError message={backupJob.error} />}
              </Card>
            )}

            <LocationCard overview={data} onSaved={reload} />

            <Card>
              <CardHeader icon={<FileArchive className="w-4 h-4" />} title="Backup history" subtitle="Backup files in the backup folders, newest first" />
              {data.backups.length === 0 ? (
                <EmptyState icon={<FileArchive className="w-5 h-5" />} title="No backups yet" hint="Click Backup to make a full project or a database backup." compact />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table stack-sm">
                    <thead>
                      <tr>
                        <th>Backup file</th>
                        <th>Created</th>
                        <th>Made by</th>
                        <th>Contents</th>
                        <th className="text-right">Size</th>
                        <th className="text-right">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.backups.map((b) => (
                        <tr key={`${b.folder}/${b.name}`}>
                          <td data-label="Backup file">
                            <div className="font-medium text-ink break-all">{b.name}</div>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {b.kind === 'SAFETY_BACKUP' ? (
                                <Pill className="bg-due-bg text-due ring-due-line">Safety backup</Pill>
                              ) : (
                                b.scope && <Pill className={SCOPE_TONE[b.scope]}>{SCOPE_LABEL[b.scope]}</Pill>
                              )}
                              {!b.valid && (
                                <Pill className="bg-missed-bg text-failed ring-failed-line" title={b.error ?? undefined}>
                                  Not a valid backup
                                </Pill>
                              )}
                            </div>
                          </td>
                          <td data-label="Created" className="whitespace-nowrap tabular-nums">
                            {formatDateTime(b.createdAt)}
                          </td>
                          <td data-label="Made by">{b.createdBy ?? '—'}</td>
                          <td data-label="Contents" className="text-ink-secondary">
                            {b.summary ?? '—'}
                          </td>
                          <td data-label="Size" className="text-right whitespace-nowrap tabular-nums">
                            {formatBytes(b.bytes)}
                          </td>
                          <td className="text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex gap-1.5">
                              <Button size="sm" variant="outline" icon={<Download className="w-3.5 h-3.5" />} onClick={() => download(b)}>
                                Download
                              </Button>
                              <Button size="sm" variant="outline" icon={<RotateCcw className="w-3.5 h-3.5" />} disabled={!b.valid || !!data.activeJob || busy} onClick={() => setRestore({ file: b.name })}>
                                Restore
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader icon={<History className="w-4 h-4" />} title="Backup & restore activity" subtitle="Every backup, safety backup and restore, with its result" />
              {data.history.length === 0 ? (
                <EmptyState icon={<History className="w-5 h-5" />} title="Nothing yet" compact />
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table stack-sm">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Activity</th>
                        <th>By</th>
                        <th>Status</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.history.map((h) => (
                        <tr key={h.id}>
                          <td data-label="When" className="whitespace-nowrap tabular-nums">
                            {formatDateTime(h.finishedAt)}
                          </td>
                          <td data-label="Activity" className="whitespace-nowrap">
                            <div className="font-medium text-ink">
                              {h.kind === 'BACKUP'
                                ? `Backup · ${SCOPE_LABEL[h.scope ?? 'DATA']}`
                                : h.kind === 'SAFETY_BACKUP'
                                  ? 'Safety backup'
                                  : `Restore${h.mode ? ` · ${MODE_LABEL[h.mode]}` : ''}`}
                            </div>
                          </td>
                          <td data-label="By">{h.by}</td>
                          <td data-label="Status">
                            <StatusPill status={h.status} />
                          </td>
                          <td data-label="Details" className="text-ink-secondary">
                            {h.file && <div className="break-all">{h.file}</div>}
                            {h.summary && <div className="text-[12px] text-ink-muted">{h.summary}</div>}
                            {h.error && <div className="text-[12px] text-failed">{h.error}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </DataState>

      {choosing && <BackupChoiceDialog starting={starting} onStart={startBackup} onClose={() => setChoosing(false)} />}

      {restore && (
        <RestoreDialog
          backups={data?.backups.filter((b) => b.valid) ?? []}
          initialFile={restore.file}
          resumeJobId={restore.jobId}
          onClose={() => {
            setRestore(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------- backup choice

/**
 * The Backup button: choose a Full project backup or a Database only backup, see what it will hold,
 * then confirm. The backup runs in the background; the app stays available.
 */
const BackupChoiceDialog: React.FC<{
  starting: boolean
  onStart: (choice: { scope: BackupScope; includeSecrets?: boolean; includePackages?: boolean }) => void
  onClose: () => void
}> = ({ starting, onStart, onClose }) => {
  const [scope, setScope] = useState<'PROJECT' | 'DATABASE'>('PROJECT')
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [includePackages, setIncludePackages] = useState(false)
  const estimate = useApi<Estimate>('/api/system/backup/estimate', { scope, secrets: includeSecrets ? '1' : '0', packages: includePackages ? '1' : '0' })
  const e = estimate.data && estimate.data.scope === scope ? estimate.data : null
  const total = e ? e.databaseBytes + e.files.bytes + (e.project?.bytes ?? 0) : 0

  const Option: React.FC<{ value: 'PROJECT' | 'DATABASE'; icon: React.ReactNode; title: string; text: string }> = ({ value, icon, title, text }) => {
    const on = scope === value
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => setScope(value)}
        className={`w-full text-left flex items-start gap-3 p-3 rounded-lg border transition-colors ${on ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}
      >
        <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? 'border-accent' : 'border-line-strong'}`}>
          {on && <span className="w-2 h-2 rounded-full bg-accent" />}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
            {icon}
            {title}
          </span>
          <span className="block mt-0.5 text-[12.5px] text-ink-secondary">{text}</span>
        </span>
      </button>
    )
  }

  return (
    <Modal
      isOpen
      onClose={starting ? () => {} : onClose}
      title="Backup"
      subtitle="Choose what to back up"
      maxWidth="xl"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" icon={<DatabaseBackup className="w-3.5 h-3.5" />} loading={starting} onClick={() => onStart(scope === 'PROJECT' ? { scope, includeSecrets, includePackages } : { scope })}>
            {scope === 'PROJECT' ? 'Start full project backup' : 'Start database backup'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-2" role="radiogroup" aria-label="What to back up">
          <Option
            value="PROJECT"
            icon={<FolderTree className="w-4 h-4 text-accent" />}
            title="Full project backup (code + database)"
            text="The whole project folder (backend, admin panel, worker app, launcher, settings, builds, scripts), the complete database and every photo, video and document, in one .zip you can use to set the application up on another computer."
          />
          <Option
            value="DATABASE"
            icon={<DatabaseBackup className="w-4 h-4 text-ink-secondary" />}
            title="Database only"
            text="Only the PostgreSQL database: every table, record, relationship and setting. No code, apps, photos or documents. Small and quick."
          />
        </div>

        {scope === 'PROJECT' && (
          <div className="rounded-lg border border-line p-3 space-y-2.5">
            <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={includeSecrets} onChange={(ev) => setIncludeSecrets(ev.target.checked)} />
              <span>
                Include server settings and keys (backend\.env, backend\secrets)
                <span className="block text-[12px] text-ink-muted">Needed to run the project on another computer without setting it up again.</span>
              </span>
            </label>
            {includeSecrets && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-exception-line bg-exception-bg text-[12px] text-exception" role="note">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                The backup will contain the database and email passwords. Anyone who has the file can read them: keep it somewhere safe.
              </div>
            )}
            <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={includePackages} onChange={(ev) => setIncludePackages(ev.target.checked)} />
              <span>
                Include installed packages (node_modules)
                <span className="block text-[12px] text-ink-muted">Over 2 GB and tens of thousands of files. Not needed: server.bat installs them on the first run (internet needed).</span>
              </span>
            </label>
          </div>
        )}

        <div className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-ink-secondary" aria-live="polite">
          {estimate.loading && !e ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Working out what goes in…
            </span>
          ) : estimate.error ? (
            <span className="text-failed">{estimate.error}</span>
          ) : e ? (
            <div className="space-y-0.5">
              <div className="font-semibold text-ink">About {formatBytes(total)} before compression</div>
              <div>Database: {formatBytes(e.databaseBytes)}</div>
              {scope === 'PROJECT' && e.project && (
                <>
                  <div>
                    Project files: {count(e.project.count, 'file')}, {formatBytes(e.project.bytes)}
                    {e.projectDir ? <span className="text-ink-muted"> · {e.projectDir}</span> : null}
                  </div>
                  <div>
                    Photos, videos and documents: {count(e.files.count, 'file')}, {formatBytes(e.files.bytes)}
                  </div>
                  {e.project.skippedBackups > 0 && (
                    <div className="text-ink-muted">{count(e.project.skippedBackups, 'earlier backup file')} in the backup folder are left out, so backups never contain other backups.</div>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
        <p className="text-[12px] text-ink-muted">
          The backup runs in the background and the app stays available. It is saved in the backup folder with today's date and time in its name, and can be downloaded
          from Backup history when it is done.
        </p>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------------------- backup location

const LocationCard: React.FC<{ overview: Overview; onSaved: () => void }> = ({ overview, onSaved }) => {
  const notify = useToast()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(overview.location)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isDefault = overview.location === overview.defaultLocation

  const save = async (path: string | null) => {
    setSaving(true)
    setErr(null)
    try {
      await api.put('/api/system/backup/location', { path })
      notify('success', 'Backup folder saved')
      setEditing(false)
      onSaved()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<FolderOpen className="w-4 h-4" />}
        title="Backup folder"
        subtitle="Where new backups are saved on the server computer"
        actions={
          !editing ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setValue(overview.location)
                setEditing(true)
              }}
            >
              Change
            </Button>
          ) : undefined
        }
      />
      <div className="p-4 space-y-3">
        {!editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="px-2 py-1 rounded bg-subtle text-[12.5px] text-ink break-all">{overview.location}</code>
            {isDefault && <Pill className="bg-accent-soft text-accent-strong ring-accent-line">Default</Pill>}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void save(value)
            }}
          >
            <Field label="Folder on the server" hint="A full path, e.g. D:\Backups\Quality. The folder is created if it does not exist.">
              <TextInput value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" autoFocus maxLength={500} />
            </Field>
            <FormError message={err} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="primary" loading={saving}>
                Save
              </Button>
              {!isDefault && (
                <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void save(null)}>
                  Use the default folder
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        <p className="text-[12px] text-ink-muted">
          Tip: keep a copy on another drive or computer (Download), so a disk failure on the server cannot take the backups with it. Passwords and keys
          (backend\.env, backend\secrets) are only in a Full project backup made with "Include server settings and keys": keep those files safe.
        </p>
      </div>
    </Card>
  )
}

// -------------------------------------------------------------------------------- restore dialog

const CHECK_STEPS = ['read', 'verify', 'database', 'upgrade', 'compare']
const APPLY_STEPS = ['safety', 'restore-db', 'restore-files']

const RestoreDialog: React.FC<{ backups: BackupFile[]; initialFile?: string; resumeJobId?: string; onClose: () => void }> = ({ backups, initialFile, resumeJobId, onClose }) => {
  const notify = useToast()
  const [source, setSource] = useState<'list' | 'upload'>(backups.length || initialFile ? 'list' : 'upload')
  const [file, setFile] = useState<string>(initialFile ?? backups[0]?.name ?? '')
  const [upload, setUpload] = useState<File | null>(null)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [jobId, setJobId] = useState<string | null>(resumeJobId ?? null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<RestoreMode | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [typed, setTyped] = useState('')
  const [applying, setApplying] = useState(false)
  // Bumped after Restore is clicked, so the finished-looking job is followed again.
  const [nonce, setNonce] = useState(0)
  const job = useJob(jobId, nonce)

  const stage: 'choose' | 'checking' | 'decide' | 'restoring' | 'done' =
    !jobId ? 'choose' : !job ? 'checking' : job.status === 'awaiting-choice' ? 'decide' : job.status === 'running' ? (job.mode ? 'restoring' : 'checking') : 'done'

  useEffect(() => {
    if (job?.status === 'success' && job.mode) notify('success', 'Restore complete', job.message ?? '')
  }, [job?.status, job?.mode, job?.message, notify])

  const check = async () => {
    setErr(null)
    try {
      if (source === 'list') {
        if (!file) return setErr('Choose a backup.')
        const j = await api.post<Job>('/api/system/backup/restore/analyse', { file })
        setJobId(j.id)
      } else {
        if (!upload) return setErr('Choose a backup file from this computer.')
        const form = new FormData()
        form.append('file', upload)
        setUploadPct(0)
        const j = await uploadWithProgress<Job>('/api/system/backup/restore/upload', form, setUploadPct)
        setJobId(j.id)
      }
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setUploadPct(null)
    }
  }

  const cancel = useCallback(async () => {
    if (jobId && job?.status === 'awaiting-choice') await api.post(`/api/system/backup/restore/${jobId}/cancel`).catch(() => {})
    onClose()
  }, [jobId, job?.status, onClose])

  const apply = async () => {
    if (!mode || !jobId) return
    setApplying(true)
    setErr(null)
    try {
      await api.post(`/api/system/backup/restore/${jobId}/apply`, { mode, confirm: typed })
      setNonce((x) => x + 1)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 503 ? 'The server is busy restoring. Please wait.' : errorText(e))
    } finally {
      setApplying(false)
    }
  }

  const canApply = !!mode && (mode === 'FULL' ? typed.trim().toUpperCase() === 'RESTORE' : understood)
  const closable = stage === 'choose' || stage === 'decide' || stage === 'done'
  const a = job?.analysis

  const footer =
    stage === 'choose' ? (
      <>
        <Button size="sm" variant="outline" onClick={onClose} disabled={uploadPct !== null}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon={<ShieldCheck className="w-3.5 h-3.5" />} onClick={check} loading={uploadPct !== null}>
          Check backup
        </Button>
      </>
    ) : stage === 'decide' ? (
      <>
        <Button size="sm" variant="outline" onClick={cancel} disabled={applying}>
          Cancel restore
        </Button>
        <Button size="sm" variant={mode === 'FULL' ? 'danger' : 'primary'} icon={<RotateCcw className="w-3.5 h-3.5" />} disabled={!canApply} loading={applying} onClick={apply}>
          {mode ? `Restore (${MODE_LABEL[mode]})` : 'Restore'}
        </Button>
      </>
    ) : stage === 'done' ? (
      <Button size="sm" variant="primary" onClick={onClose}>
        Close
      </Button>
    ) : undefined

  return (
    <Modal isOpen onClose={closable ? (stage === 'decide' ? cancel : onClose) : () => {}} title="Restore from a backup" subtitle={job?.file ?? undefined} maxWidth="2xl" footer={footer}>
      <div className="space-y-4">
        {stage === 'choose' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Where is the backup?">
              {(['list', 'upload'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={source === s}
                  onClick={() => setSource(s)}
                  className={`text-left p-3 rounded-lg border transition-colors ${source === s ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}
                >
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    {s === 'list' ? <FileArchive className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                    {s === 'list' ? 'A backup on the server' : 'A file from this computer'}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-muted">{s === 'list' ? 'From the backup folder' : 'A .zip made by Backup & Restore'}</div>
                </button>
              ))}
            </div>
            {source === 'list' ? (
              backups.length ? (
                <Field label="Backup">
                  <div className="max-h-64 overflow-y-auto rounded-md border border-line divide-y divide-line" role="radiogroup" aria-label="Backup">
                    {backups.map((b) => (
                      <label key={`${b.folder}/${b.name}`} className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer ${file === b.name ? 'bg-accent-soft' : 'hover:bg-subtle'}`}>
                        <input type="radio" name="backup" className="mt-1" checked={file === b.name} onChange={() => setFile(b.name)} />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ink break-all">{b.name}</span>
                          <span className="block text-[12px] text-ink-muted">
                            {formatDateTime(b.createdAt)} · {b.summary} · {formatBytes(b.bytes)}
                            {b.kind === 'SAFETY_BACKUP' ? ' · Safety backup' : ''}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </Field>
              ) : (
                <p className="text-[13px] text-ink-muted">There are no backups in the backup folder. Choose a file from this computer instead.</p>
              )
            ) : (
              <Field label="Backup file (.zip)">
                <input
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(e) => setUpload(e.target.files?.[0] ?? null)}
                  className="block w-full text-[13px] file:mr-3 file:h-8 file:px-3 file:rounded-md file:border file:border-line-strong file:bg-white file:text-[13px] file:font-medium"
                />
                {uploadPct !== null && (
                  <div className="mt-2">
                    <ProgressBar percent={Math.round(uploadPct * 100)} state="running" label="Upload" />
                    <div className="mt-1 text-[12px] text-ink-muted">Uploading… {Math.round(uploadPct * 100)}%</div>
                  </div>
                )}
              </Field>
            )}
            <p className="text-[12px] text-ink-muted">
              The backup is checked first: every file in it is verified and its data compared with the current data. Nothing is changed until you choose how to restore.
            </p>
          </>
        )}

        {stage === 'checking' && (job ? <JobProgress job={job} only={CHECK_STEPS} /> : <Loader2 className="w-5 h-5 animate-spin text-accent" />)}

        {stage === 'decide' && a && (
          <>
            <div className="grid grid-cols-2 gap-2 text-[12.5px]">
              <Fact label="Backup made" value={formatDateTime(a.backup.createdAt)} />
              <Fact label="Made by" value={a.backup.createdBy} />
              <Fact label="Records" value={n(a.totals.backupRows)} />
              <Fact label="Files" value={`${n(a.totals.backupFiles)} · ${formatBytes(a.files.reduce((x, f) => x + f.backupBytes, 0))}`} />
            </div>
            {(a.notes ?? []).map((t) => (
              <div key={t} className="flex items-start gap-2 px-3 py-2 rounded-md border border-line bg-subtle text-[12.5px] text-ink-secondary" role="note">
                <FileArchive className="w-3.5 h-3.5 shrink-0 mt-0.5 text-ink-muted" aria-hidden />
                {t}
              </div>
            ))}
            {a.warnings.map((w) => (
              <div key={w} className="flex items-start gap-2 px-3 py-2 rounded-md border border-exception-line bg-exception-bg text-[12.5px] text-exception" role="note">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                {w}
              </div>
            ))}

            <div className={`rounded-lg border px-3 py-2.5 text-[13px] ${a.duplicates ? 'border-due-line bg-due-bg' : 'border-line bg-subtle'}`}>
              <div className="font-semibold text-ink">{a.duplicates ? 'Some of this data already exists' : 'None of this data exists yet'}</div>
              <div className="mt-0.5 text-ink-secondary">
                Records: <b>{n(a.totals.newRows)}</b> new, <b>{n(a.totals.sameId)}</b> already exist ({n(a.totals.sameId - a.totals.different)} identical, {n(a.totals.different)} different).
                Files: <b>{n(a.totals.newFiles)}</b> new, <b>{n(a.totals.existingFiles)}</b> already exist.
              </div>
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[12.5px] text-accent">Details by table and folder</summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th className="text-right">In backup</th>
                        <th className="text-right">New</th>
                        <th className="text-right">Identical</th>
                        <th className="text-right">Different</th>
                        <th className="text-right">Only current</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.tables
                        .filter((t) => t.backupRows || t.liveRows)
                        .map((t) => (
                          <tr key={t.table}>
                            <td>{tableName(t.table)}</td>
                            <td className="text-right tabular-nums">{n(t.backupRows)}</td>
                            <td className="text-right tabular-nums">{n(t.newRows)}</td>
                            <td className="text-right tabular-nums">{n(t.identical)}</td>
                            <td className="text-right tabular-nums">{n(t.different)}</td>
                            <td className="text-right tabular-nums">{n(Math.max(0, t.liveRows - t.sameId))}</td>
                          </tr>
                        ))}
                      {a.files.map((f) => (
                        <tr key={f.key}>
                          <td>{f.label} (files)</td>
                          <td className="text-right tabular-nums">{n(f.backupFiles)}</td>
                          <td className="text-right tabular-nums">{n(f.newFiles)}</td>
                          <td className="text-right tabular-nums">{n(f.identical)}</td>
                          <td className="text-right tabular-nums">{n(f.different)}</td>
                          <td className="text-right tabular-nums">{n(f.liveOnly)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>

            <div className="space-y-2" role="radiogroup" aria-label="How to restore">
              <ModeOption
                mode="SKIP"
                selected={mode}
                onSelect={setMode}
                title="Skip duplicate data"
                text={`Adds only what is missing: ${count(a.totals.newRows, 'new record')} and ${count(a.totals.newFiles, 'new file')}. Records and files that already exist are kept exactly as they are; nothing is overwritten or deleted.`}
              />
              <ModeOption
                mode="REPLACE"
                selected={mode}
                onSelect={setMode}
                title="Replace existing data"
                text={`Adds ${count(a.totals.newRows, 'new record')} and replaces ${count(a.totals.different, 'existing record')} that differ (same ID) with the backup's version; changed files are replaced too. Data added since the backup is kept. Relationships between records stay intact.`}
              />
              <ModeOption
                mode="FULL"
                selected={mode}
                onSelect={setMode}
                danger
                title="Restore everything (full restore)"
                text={`Makes the whole project exactly as it was on ${formatDateTime(a.backup.createdAt)}. Everything added or changed since then is permanently removed: about ${count(a.tables.reduce((x, t) => x + Math.max(0, t.liveRows - t.sameId), 0), 'record')} and ${count(a.files.reduce((x, f) => x + f.liveOnly, 0), 'file')} that are not in the backup. Users may have to sign in again.`}
              />
            </div>

            {mode && (
              <div className="space-y-2">
                <p className="text-[12.5px] text-ink-secondary">
                  Before anything changes, a <b>safety backup</b> of the current data is made automatically. During the restore the app is paused for everyone (usually under a
                  minute). If the restore fails, nothing is changed.
                </p>
                {mode === 'FULL' ? (
                  <Field label="Type RESTORE to confirm the full restore" required>
                    <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RESTORE" autoComplete="off" className="font-mono uppercase" />
                  </Field>
                ) : (
                  <label className="flex items-start gap-2 text-[13px] text-ink cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand what “{MODE_LABEL[mode]}” will do to the
                    current data.
                  </label>
                )}
              </div>
            )}
          </>
        )}

        {stage === 'restoring' && job && (
          <>
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-due-line bg-due-bg text-[12.5px] text-ink" role="status">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-due" aria-hidden />
              Restoring with “{job.mode ? MODE_LABEL[job.mode] : ''}”. The app is paused for everyone until this finishes. Please keep this window open.
            </div>
            <JobProgress job={job} only={APPLY_STEPS} />
          </>
        )}

        {stage === 'done' && job && <RestoreResult job={job} />}

        <FormError message={err} />
      </div>
    </Modal>
  )
}

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md bg-subtle px-2.5 py-2 min-w-0">
    <div className="text-[11.5px] text-ink-muted">{label}</div>
    <div className="font-medium text-ink truncate" title={value}>
      {value}
    </div>
  </div>
)

const ModeOption: React.FC<{ mode: RestoreMode; selected: RestoreMode | null; onSelect: (m: RestoreMode) => void; title: string; text: string; danger?: boolean }> = ({
  mode,
  selected,
  onSelect,
  title,
  text,
  danger
}) => {
  const on = selected === mode
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => onSelect(mode)}
      className={`w-full text-left flex items-start gap-3 p-3 rounded-lg border transition-colors ${
        on ? (danger ? 'border-failed-line bg-missed-bg' : 'border-accent bg-accent-soft') : 'border-line hover:border-line-strong'
      }`}
    >
      <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? (danger ? 'border-failed' : 'border-accent') : 'border-line-strong'}`}>
        {on && <span className={`w-2 h-2 rounded-full ${danger ? 'bg-failed' : 'bg-accent'}`} />}
      </span>
      <span className="min-w-0">
        <span className={`flex items-center gap-1.5 text-[13.5px] font-semibold ${danger ? 'text-failed' : 'text-ink'}`}>
          {danger && <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
          {title}
        </span>
        <span className="block mt-0.5 text-[12.5px] text-ink-secondary">{text}</span>
      </span>
    </button>
  )
}

const RestoreResult: React.FC<{ job: Job }> = ({ job }) => {
  const r = job.result
  const ok = job.status === 'success'
  const cancelled = job.status === 'cancelled'
  const tables = (r?.tables ?? []).filter((t) => t.added || t.updated || t.failed)
  return (
    <div className="space-y-3">
      <div
        className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-[13px] ${ok ? 'border-success-line bg-success-bg' : cancelled ? 'border-line bg-subtle' : 'border-failed-line bg-missed-bg'}`}
        role={ok || cancelled ? 'status' : 'alert'}
      >
        {ok ? <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" /> : cancelled ? <Ban className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-failed shrink-0 mt-0.5" />}
        <div>
          <div className="font-semibold text-ink">{ok ? 'Restore complete' : cancelled ? 'Restore cancelled' : 'Restore failed'}</div>
          <div className="text-ink-secondary">{ok || cancelled ? job.message : job.error}</div>
          {r?.safetyBackup && <div className="mt-1 text-[12px] text-ink-muted">Safety backup of the data before the restore: {r.safetyBackup}</div>}
        </div>
      </div>
      <JobProgress job={job} only={job.mode ? APPLY_STEPS : CHECK_STEPS} />
      {tables.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Data</th>
                <th className="text-right">Added</th>
                <th className="text-right">Replaced</th>
                <th className="text-right">Not restored</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.table}>
                  <td>
                    {tableName(t.table)}
                    {t.errors.length > 0 && <div className="text-[11.5px] text-failed">{t.errors[0]}</div>}
                  </td>
                  <td className="text-right tabular-nums">{n(t.added)}</td>
                  <td className="text-right tabular-nums">{n(t.updated)}</td>
                  <td className="text-right tabular-nums">{n(t.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ok && job.mode === 'FULL' && <p className="text-[12.5px] text-ink-muted">If your account was different in the backup, you will be asked to sign in again.</p>}
    </div>
  )
}
