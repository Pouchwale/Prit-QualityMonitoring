import React, { useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardList, FileText, Gauge, ListChecks, Trophy, UserRound, X, XCircle } from 'lucide-react'
import type { User } from '../../../types'
import { useApi } from '../../../lib/useApi'
import { download, errorText } from '../../../lib/api'
import { formatDate, formatTime } from '../../../lib/format'
import { Button } from '../../../components/common/Button'
import { DataState } from '../../../components/common/DataState'
import { Select } from '../../../components/common/Form'
import { useToast } from '../../../components/common/Toast'
import { Card, CardHeader } from '../../../components/ui/Card'
import { StatCard } from '../../../components/ui/StatCard'

type Outcome = 'COMPLETED' | 'EXCEPTION' | 'MISSED'

interface ScoreTask {
  id: string
  code: string
  task: string
  machine: string | null
  shift: string | null
  jobNo: string | null
  scheduledAt: string
  dueBy: string | null
  submittedAt: string | null
  outcome: Outcome
  lateMinutes: number | null
  points: number
}

interface WorkerScore {
  workerId: string
  name: string
  employeeId: string
  assigned: number
  completed: number
  exceptions: number
  missed: number
  pending: number
  completionRate: number
  pointsPerTask: number
  deduction: number
  score: number
  missedTasks?: ScoreTask[]
  completedTasks?: ScoreTask[]
}

interface ScoreReport {
  from: string
  to: string
  worker: { id: string; name: string; employeeId: string } | null
  totals: { workers: number; assigned: number; completed: number; exceptions: number; missed: number; pending: number; completionRate: number; score: number }
  workers: WorkerScore[]
}

const SCORE_HINT =
  'Each assigned task is worth 100 ÷ assigned tasks points. A missed task deducts its points; a completed or exception task keeps them. Score = completion % − 100, so 0 is every task done and −100 is none. Assigned tasks are those whose time is over; open tasks are not counted yet, and tasks excused by an approved machine breakdown, Late Entry or Early Exit are never counted. The same score as the Performance page.'

const pts = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n < 0 ? `−${Math.abs(n).toFixed(2)}` : '0.00')
const scoreTone = (s: number) => (s === 0 ? 'text-success' : s >= -20 ? 'text-exception' : 'text-missed')
const lateText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min late` : `${m} min late`)

const When: React.FC<{ iso: string | null }> = ({ iso }) =>
  iso ? (
    <div className="whitespace-nowrap">
      <div>{formatDate(iso)}</div>
      <div className="text-[13px] text-ink-muted">{formatTime(iso)}</div>
    </div>
  ) : (
    <span className="text-ink-faint">—</span>
  )

const TaskName: React.FC<{ t: ScoreTask }> = ({ t }) => (
  <div className="min-w-[150px]">
    <div className="font-medium text-ink">{t.task}</div>
    <div className="text-[12.5px] text-ink-muted font-mono">
      {t.code}
      {t.jobNo ? ` · PO ${t.jobNo}` : ''}
    </div>
  </div>
)

/**
 * Worker Score Report: each worker's score and the tasks behind it, for the chosen dates and
 * optionally one worker (GET /api/reports/score-summary[.pdf]). Counted as on the Performance page.
 * The task lists show for one worker at a time; the PDF has them for everyone in it. Text only.
 */
export const ScoreSummarySection: React.FC<{ from: string; to: string; period: string; canExport: boolean }> = ({ from, to, period, canExport }) => {
  const [workerId, setWorkerId] = useState('')
  const workers = useApi<User[]>('/api/users', { role: 'WORKER' })
  const { data, error, loading, reload } = useApi<ScoreReport>('/api/reports/score-summary', { from, to, workerId: workerId || undefined })
  const [downloading, setDownloading] = useState(false)
  const notify = useToast()

  const downloadPdf = async () => {
    setDownloading(true)
    try {
      const name = await download('/api/reports/score-summary.pdf', { from, to, workerId: workerId || undefined }, `Worker-Score-Report-${from.replace(/-/g, '')}.pdf`)
      notify('success', 'Worker Score Report downloaded', name)
    } catch (err) {
      notify('error', 'Could not create the PDF', errorText(err))
    } finally {
      setDownloading(false)
    }
  }

  const t = data?.totals
  const selected = workerId ? data?.workers.find((w) => w.workerId === workerId) : undefined
  const workerName = workerId ? (data?.worker?.name ?? workers.data?.find((w) => w.id === workerId)?.name ?? 'Selected worker') : null

  return (
    <>
      <section className="card px-3 py-2.5 flex flex-wrap items-end gap-2.5" aria-label="Worker filter">
        <label className="min-w-0 flex-1 sm:flex-none">
          <span className="block text-[12.5px] font-medium text-ink-muted mb-1">Worker</span>
          <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)} className="w-full sm:w-64">
            <option value="">All workers</option>
            {(workers.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.employeeId}){w.isActive === false ? ' · disabled' : ''}
              </option>
            ))}
          </Select>
        </label>
        {workerId && (
          <Button size="field" variant="ghost" onClick={() => setWorkerId('')} icon={<X className="w-3.5 h-3.5" />}>
            Clear
          </Button>
        )}
        {canExport && (
          <Button size="field" variant="primary" className="sm:ml-auto" onClick={downloadPdf} loading={downloading} disabled={!data} icon={<FileText className="w-3.5 h-3.5" />}>
            Download PDF
          </Button>
        )}
        <p className="basis-full text-[13px] text-ink-muted">
          {workerName ? `${workerName} · ${period}. ` : `All workers · ${period}. Choose a worker to see each missed and completed task; `}
          {workerName ? 'The PDF has this worker’s score and every task.' : 'the PDF has every worker’s tasks.'}
        </p>
      </section>

      {/* Keeps the last figures on screen while new dates or another worker load. */}
      <DataState loading={loading} error={error} onRetry={reload} empty={data ? false : undefined}>
        {t && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="Assigned tasks" value={t.assigned} icon={<ClipboardList className="w-4 h-4" />} meta={t.pending ? `${t.pending} still open` : period} />
            <StatCard label="Completed" value={t.completed} icon={<CheckCircle2 className="w-4 h-4" />} tone="success" meta="Submitted with readings" />
            <StatCard label="Exception" value={t.exceptions} icon={<AlertTriangle className="w-4 h-4" />} tone={t.exceptions ? 'exception' : 'neutral'} meta="Counted as done" />
            <StatCard label="Missed" value={t.missed} icon={<XCircle className="w-4 h-4" />} tone={t.missed ? 'missed' : 'neutral'} alert={t.missed > 0} meta={t.missed ? 'Lower the score' : 'None'} />
            <StatCard label="Completion" value={`${t.completionRate}%`} icon={<Gauge className="w-4 h-4" />} tone="accent" meta={`${t.completed + t.exceptions} of ${t.assigned} done`} />
            <StatCard
              label={workerId ? 'Final score' : 'Overall score'}
              value={t.score}
              icon={<Trophy className="w-4 h-4" />}
              tone={t.score === 0 ? 'success' : t.score >= -20 ? 'exception' : 'missed'}
              meta={`${t.completionRate}% − 100`}
            />
          </div>
        )}

        <Card className="overflow-hidden">
          <CardHeader
            icon={<UserRound className="w-4 h-4" />}
            title="Worker scores"
            subtitle={`${period} · ${data?.workers.length ?? 0} worker${data?.workers.length === 1 ? '' : 's'} · lowest score first`}
            info={SCORE_HINT}
          />
          {!data?.workers.length ? (
            <p className="px-4 py-8 text-center text-[14px] text-ink-muted">No assigned tasks in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th className="num">Assigned</th>
                    <th className="num">Completed</th>
                    <th className="num">Exception</th>
                    <th className="num">Missed</th>
                    <th className="num" title="Points one task is worth: 100 ÷ assigned">Per task</th>
                    <th className="num" title="Missed × points per task">Deduction</th>
                    <th className="num">Completion</th>
                    <th className="num">Score</th>
                    {!workerId && <th aria-label="Tasks" />}
                  </tr>
                </thead>
                <tbody>
                  {data.workers.map((w) => (
                    <tr key={w.workerId}>
                      <td className="whitespace-nowrap">
                        <div className="font-medium text-ink">{w.name}</div>
                        <div className="text-[13px] text-ink-muted font-mono">{w.employeeId}</div>
                      </td>
                      <td className="num">{w.assigned}</td>
                      <td className="num text-success">{w.completed}</td>
                      <td className={`num ${w.exceptions ? 'text-exception' : 'text-ink-faint'}`}>{w.exceptions}</td>
                      <td className={`num ${w.missed ? 'text-missed font-semibold' : 'text-ink-faint'}`}>{w.missed}</td>
                      <td className="num text-ink-muted">{w.pointsPerTask.toFixed(2)}</td>
                      <td className={`num ${w.deduction ? 'text-missed' : 'text-ink-faint'}`}>{pts(-w.deduction)}</td>
                      <td className="num">{w.completionRate}%</td>
                      <td className={`num font-semibold ${scoreTone(w.score)}`}>{w.score}</td>
                      {!workerId && (
                        <td className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setWorkerId(w.workerId)} icon={<ListChecks className="w-3.5 h-3.5" />}>
                            Tasks
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {selected && <WorkerTasks w={selected} />}
      </DataState>
    </>
  )
}

/** One worker's missed tasks (with the points each deducted), then completed and exception tasks (points kept). */
const WorkerTasks: React.FC<{ w: WorkerScore }> = ({ w }) => {
  const missed = w.missedTasks ?? []
  const done = w.completedTasks ?? []
  return (
    <>
      <p className="card px-4 py-3 text-[14px] text-ink-secondary">
        <span className="font-semibold text-ink">{w.name}:</span> {w.completed + w.exceptions} of {w.assigned} tasks done = {w.completionRate}% completion; {w.completionRate}% − 100 ={' '}
        <span className={`font-semibold ${scoreTone(w.score)}`}>{w.score}</span>. Each task is worth {w.pointsPerTask.toFixed(2)} points, so the {w.missed} missed task
        {w.missed === 1 ? '' : 's'} deducted {w.deduction.toFixed(2)}.{w.pending ? ` ${w.pending} task${w.pending === 1 ? ' is' : 's are'} still open and not counted yet.` : ''}
      </p>

      <Card className="overflow-hidden">
        <CardHeader icon={<XCircle className="w-4 h-4" />} title={`Missed tasks (${missed.length})`} subtitle={`${w.name} · ${pts(-w.deduction)} points`} />
        {missed.length === 0 ? (
          <p className="px-4 py-6 text-center text-[14px] text-success">No missed tasks.</p>
        ) : (
          <div className="overflow-x-auto lg:max-h-[480px] lg:overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Scheduled</th>
                  <th>Due by</th>
                  <th>Task</th>
                  <th>Machine</th>
                  <th>Shift</th>
                  <th className="num">Deduction</th>
                </tr>
              </thead>
              <tbody>
                {missed.map((t, i) => (
                  <tr key={t.id}>
                    <td className="num text-ink-muted">{i + 1}</td>
                    <td>
                      <When iso={t.scheduledAt} />
                    </td>
                    <td className="whitespace-nowrap">{t.dueBy ? formatTime(t.dueBy) : '—'}</td>
                    <td>
                      <TaskName t={t} />
                    </td>
                    <td>{t.machine ?? '—'}</td>
                    <td className="whitespace-nowrap">{t.shift ?? '—'}</td>
                    <td className="num font-semibold text-missed">{pts(t.points)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader icon={<CheckCircle2 className="w-4 h-4" />} title={`Completed tasks (${done.length})`} subtitle={`${w.name} · completed and exception tasks keep their points`} />
        {done.length === 0 ? (
          <p className="px-4 py-6 text-center text-[14px] text-ink-muted">No completed tasks.</p>
        ) : (
          <div className="overflow-x-auto lg:max-h-[560px] lg:overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Scheduled</th>
                  <th>Submitted</th>
                  <th>Task</th>
                  <th>Machine</th>
                  <th>Status</th>
                  <th className="num">Earned</th>
                </tr>
              </thead>
              <tbody>
                {done.map((t, i) => (
                  <tr key={t.id}>
                    <td className="num text-ink-muted">{i + 1}</td>
                    <td>
                      <When iso={t.scheduledAt} />
                    </td>
                    <td>
                      <When iso={t.submittedAt} />
                    </td>
                    <td>
                      <TaskName t={t} />
                    </td>
                    <td>{t.machine ?? '—'}</td>
                    <td className="whitespace-nowrap">
                      <div className={`font-semibold ${t.outcome === 'EXCEPTION' ? 'text-exception' : 'text-success'}`}>{t.outcome === 'EXCEPTION' ? 'Exception' : 'Completed'}</div>
                      <div className={`text-[13px] ${t.lateMinutes !== null ? 'text-exception' : 'text-ink-muted'}`}>{t.lateMinutes !== null ? lateText(t.lateMinutes) : 'On time'}</div>
                    </td>
                    <td className="num font-semibold text-success">{pts(t.points)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
