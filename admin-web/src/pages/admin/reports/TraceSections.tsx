import React from 'react'
import type { QualityCheck, TraceChange, TraceGroup, TraceReport, TraceWorker } from '../../../types'
import { formatDateTime } from '../../../lib/format'
import { StatusBadge } from '../../../components/common/StatusBadge'
import { itemCodeOf, jobNoOf, readingText } from './checkFields'

const doerOf = (c: QualityCheck) => ({
  name: c.submittedByName ?? c.workerName ?? 'Unassigned',
  employeeId: c.submittedByEmployeeId ?? c.workerEmployeeId
})

const NONE = <span className="text-ink-faint">None</span>
const list = (values: string[]) => (values.filter(Boolean).length ? values.filter(Boolean).join(', ') : NONE)

const Card: React.FC<{ title: string; note?: React.ReactNode; count?: number; children: React.ReactNode }> = ({ title, note, count, children }) => (
  <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden printable-card">
    <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex items-center justify-between gap-3">
      <div>
        <h2 className="text-sm font-bold text-ink">{title}</h2>
        {note && <p className="text-[11px] text-ink-muted">{note}</p>}
      </div>
      {count !== undefined && <span className="text-xs font-mono font-semibold text-ink">{count}</span>}
    </div>
    {children}
  </section>
)

const Num: React.FC<{ value: number; tone?: string }> = ({ value, tone = 'text-ink' }) => (
  <td className={`py-1.5 px-2 text-right font-mono ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)

const th = 'py-2 px-2 font-semibold'
const thead = 'border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider'

/** Headline numbers of the traced records. */
export const TraceSummary: React.FC<{ trace: TraceReport; scope: string }> = ({ trace, scope }) => {
  const c = trace.counts
  const tiles: { label: string; value: number | string; tone?: string }[] = [
    { label: 'Times checked', value: c.checks },
    { label: 'Completed', value: c.completed, tone: 'text-success' },
    { label: 'Missed', value: c.missed, tone: 'text-missed' },
    { label: 'Exceptions', value: c.exceptions, tone: 'text-exception' },
    { label: 'Readings', value: c.readings },
    { label: 'Outside limits', value: c.outsideLimits, tone: 'text-failed' },
    { label: 'Changes', value: c.changes },
    { label: 'Corrections', value: c.corrections, tone: 'text-success' },
    { label: 'Item Codes', value: trace.items.filter((i) => i.key).length },
    { label: 'Job Nos.', value: trace.jobs.filter((j) => j.key).length }
  ]
  return (
    <Card title={`Traceability: ${scope}`} note="Every check, reading, change and exception for the selected Item Code, Job No. and worker in this period.">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-line">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white px-3 py-2">
            <div className="text-[11px] font-medium text-ink-secondary">{t.label}</div>
            <div className={`text-xl font-bold font-mono ${t.value ? (t.tone ?? 'text-ink') : 'text-ink-faint'}`}>{t.value}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Per Item Code (with its Job Nos.) or per Job No. (with its Item Codes). */
export const TraceGroupTable: React.FC<{ kind: 'item' | 'job'; rows: TraceGroup[]; onPick?: (value: string) => void }> = ({ kind, rows, onPick }) => {
  const isItem = kind === 'item'
  return (
    <Card
      title={isItem ? 'Item Codes' : 'Job Nos.'}
      note={isItem ? 'How many times each item was checked, on which jobs, by whom and on which machines.' : 'Each job with its item codes, checks, workers and machines.'}
      count={rows.length}
    >
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-ink-muted">No records.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="pin-first w-full text-left text-xs border-collapse">
            <thead className={thead}>
              <tr>
                <th className={`${th} px-3`}>{isItem ? 'Item Code' : 'Job No.'}</th>
                <th className={th}>{isItem ? 'Job Nos.' : 'Item Codes'}</th>
                <th className={`${th} text-right`}>Checks</th>
                <th className={`${th} text-right`}>Completed</th>
                <th className={`${th} text-right`}>Missed</th>
                <th className={`${th} text-right`}>Exception</th>
                <th className={`${th} text-right`}>Readings</th>
                <th className={`${th} text-right`}>Outside limits</th>
                <th className={`${th} text-right`}>Changes</th>
                <th className={`${th} text-right`}>Corrections</th>
                <th className={th}>Workers</th>
                <th className={th}>Machines</th>
                <th className={`${th} px-3`}>First / last check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.key || '—'}>
                  <td className="py-1.5 px-3 whitespace-nowrap font-mono font-semibold">
                    {r.key && onPick ? (
                      <button type="button" className="text-accent hover:underline" title={`Show only ${r.key}`} onClick={() => onPick(r.key)}>
                        {r.key}
                      </button>
                    ) : (
                      r.key || NONE
                    )}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-ink-secondary">{list(isItem ? r.jobNos : r.itemCodes)}</td>
                  <Num value={r.checks} />
                  <Num value={r.completed} tone="text-success" />
                  <Num value={r.missed} tone="text-missed" />
                  <Num value={r.exceptions} tone="text-exception" />
                  <Num value={r.readings} />
                  <Num value={r.outsideLimits} tone="text-failed" />
                  <Num value={r.changes} />
                  <Num value={r.corrections} tone="text-success" />
                  <td className="py-1.5 px-2">{list(r.workers)}</td>
                  <td className="py-1.5 px-2 text-ink-secondary">{list(r.machines)}</td>
                  <td className="py-1.5 px-3 font-mono whitespace-nowrap text-ink-secondary">
                    {formatDateTime(r.firstAt)}
                    <br />
                    {formatDateTime(r.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/** Each worker with every Item Code they checked, its Job Nos. and number of checks. */
export const TraceWorkers: React.FC<{ workers: TraceWorker[]; onPickItem?: (value: string) => void }> = ({ workers, onPickItem }) => (
  <Card title="Worker activity by Item Code" note="Checks are counted for the worker who submitted them, or the worker they were assigned to." count={workers.length}>
    {workers.length === 0 ? (
      <div className="px-4 py-6 text-center text-xs text-ink-muted">No records.</div>
    ) : (
      <div className="divide-y divide-line">
        {workers.map((w) => (
          <div key={w.workerId ?? w.name} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
              <span className="font-bold text-ink">{w.name}</span>
              {w.employeeId && <span className="font-mono text-ink-muted">{w.employeeId}</span>}
              <span className="text-ink-secondary">
                {w.checks} checks · {w.completed} completed · {w.missed} missed · {w.exceptions} exception · {w.changes} changes ({w.corrections} corrections)
              </span>
              <span className="text-ink-muted">Machines: {list(w.machines)}</span>
            </div>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-left text-xs border-collapse">
                <thead className={thead}>
                  <tr>
                    <th className={`${th} pl-0`}>Item Code</th>
                    <th className={th}>Job Nos.</th>
                    <th className={`${th} text-right`}>Checks</th>
                    <th className={`${th} text-right`}>Completed</th>
                    <th className={`${th} text-right`}>Missed</th>
                    <th className={`${th} text-right`}>Exception</th>
                    <th className={`${th} text-right`}>Changes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {w.items.map((i) => (
                    <tr key={i.itemCode || '—'}>
                      <td className="py-1.5 pr-2 font-mono font-semibold whitespace-nowrap">
                        {i.itemCode && onPickItem ? (
                          <button type="button" className="text-accent hover:underline" onClick={() => onPickItem(i.itemCode)}>
                            {i.itemCode}
                          </button>
                        ) : (
                          i.itemCode || NONE
                        )}
                      </td>
                      <td className="py-1.5 px-2 font-mono text-ink-secondary">{list(i.jobNos)}</td>
                      <Num value={i.checks} />
                      <Num value={i.completed} tone="text-success" />
                      <Num value={i.missed} tone="text-missed" />
                      <Num value={i.exceptions} tone="text-exception" />
                      <Num value={i.changes} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    )}
  </Card>
)

const changeType = (ch: TraceChange) =>
  ch.correction ? (
    <span className="px-1.5 py-px rounded border border-success-line bg-success-bg text-success text-[11px] font-semibold">Correction</span>
  ) : ch.wentOutside ? (
    <span className="px-1.5 py-px rounded border border-missed-line bg-missed-bg text-missed text-[11px] font-semibold">Went outside limits</span>
  ) : (
    <span className="px-1.5 py-px rounded border border-line bg-slate-50 text-ink-secondary text-[11px] font-semibold">Change</span>
  )

/** Every reading that changed from the previous reading of the same parameter. */
export const TraceChanges: React.FC<{ changes: TraceChange[] }> = ({ changes }) => (
  <Card
    title="Changes and corrections"
    note="A change is a reading that differs from the previous reading of the same parameter for the same item, job and machine. A correction is a change from outside limits back within limits."
    count={changes.length}
  >
    {changes.length === 0 ? (
      <div className="px-4 py-6 text-center text-xs text-ink-muted">No reading changed in this period.</div>
    ) : (
      <div className="overflow-x-auto">
        <table className="stack-sm w-full text-left text-xs border-collapse">
          <thead className={thead}>
            <tr>
              <th className={`${th} px-3`}>Date / time</th>
              <th className={th}>Machine</th>
              <th className={th}>Item Code</th>
              <th className={th}>Job No.</th>
              <th className={th}>Parameter</th>
              <th className={th}>From → To</th>
              <th className={th}>Type</th>
              <th className={th}>Changed by</th>
              <th className={`${th} px-3`}>Previous reading</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {changes.map((ch, i) => (
              <tr key={`${ch.checkId}-${ch.parameterName}-${i}`}>
                <td className="py-1.5 px-3 font-mono whitespace-nowrap">{formatDateTime(ch.at)}</td>
                <td className="py-1.5 px-2 whitespace-nowrap">{ch.machineName}</td>
                <td className="py-1.5 px-2 font-mono">{ch.itemCode || NONE}</td>
                <td className="py-1.5 px-2 font-mono">{ch.jobNo || NONE}</td>
                <td className="py-1.5 px-2 font-medium text-ink">{ch.parameterName}</td>
                <td className="py-1.5 px-2 font-mono whitespace-nowrap">
                  {readingText(ch.from)}
                  {ch.unit ? ` ${ch.unit}` : ''} → <span className="font-semibold">{readingText(ch.to)}</span>
                  {ch.unit ? ` ${ch.unit}` : ''}
                  <div className="font-sans text-[11px] text-ink-muted">
                    {ch.fromResult} → {ch.toResult}
                  </div>
                </td>
                <td className="py-1.5 px-2 whitespace-nowrap">{changeType(ch)}</td>
                <td className="py-1.5 px-2 whitespace-nowrap">
                  {ch.byName}
                  {ch.byEmployeeId && <span className="text-[11px] text-ink-muted font-mono"> · {ch.byEmployeeId}</span>}
                </td>
                <td className="py-1.5 px-3 text-ink-secondary whitespace-nowrap">
                  {ch.previousByName}, {formatDateTime(ch.previousAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Card>
)

const readingTone = (v: QualityCheck['values'][number]) =>
  v.notApplicable ? 'bg-slate-50 text-ink-muted border-line' : v.result === 'FAIL' ? 'bg-missed-bg text-missed border-missed-line' : 'bg-white text-ink border-line'

/** Every check in full: when, where, item and job, who, result, every reading and the exception. */
export const DetailedRecords: React.FC<{ checks: QualityCheck[]; onViewCheck?: (id: string) => void }> = ({ checks, onViewCheck }) => (
  <Card title="Detailed records" note="Every check with all its parameter readings, who did it and any exception." count={checks.length}>
    {checks.length === 0 ? (
      <div className="px-4 py-6 text-center text-xs text-ink-muted">No records.</div>
    ) : (
      <div className="overflow-x-auto">
        <table className="stack-sm w-full text-left text-xs border-collapse">
          <thead className={thead}>
            <tr>
              <th className={`${th} px-3`}>Date / time</th>
              <th className={th}>Machine</th>
              <th className={th}>Item Code</th>
              <th className={th}>Job No.</th>
              <th className={th}>Check type</th>
              <th className={th}>Worker</th>
              <th className={th}>Result</th>
              <th className={`${th} px-3`}>Readings and remarks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {checks.map((c) => {
              const doer = doerOf(c)
              return (
                <tr key={c.id} className="align-top">
                  <td className="py-2 px-3 font-mono whitespace-nowrap">
                    {formatDateTime(c.submittedAt ?? c.scheduledAt)}
                    <div className="text-[11px] text-ink-muted">
                      {onViewCheck ? (
                        <button type="button" className="hover:underline hover:text-accent" onClick={() => onViewCheck(c.id)}>
                          {c.code}
                        </button>
                      ) : (
                        c.code
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap">
                    {c.machineName}
                    <div className="text-[11px] text-ink-muted font-mono">{c.machineCode}</div>
                  </td>
                  <td className="py-2 px-2 font-mono whitespace-nowrap">{itemCodeOf(c) || NONE}</td>
                  <td className="py-2 px-2 font-mono whitespace-nowrap">{jobNoOf(c) || NONE}</td>
                  <td className="py-2 px-2 text-ink-secondary">
                    {c.activityName}
                    <div className="text-[11px] text-ink-muted">{c.shiftName ?? ''}</div>
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap">
                    {doer.name}
                    {doer.employeeId && <div className="text-[11px] text-ink-muted font-mono">{doer.employeeId}</div>}
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap">
                    {c.result ? <StatusBadge status={c.result} size="sm" /> : <span className="text-ink-faint">Open</span>}
                    {c.submissionType && <div className="text-[11px] text-ink-muted mt-0.5">{c.submissionType === 'MANUAL' ? 'Manual' : 'Notification'}</div>}
                  </td>
                  <td className="py-2 px-3">
                    {c.values.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {c.values.map((v) => (
                          <span
                            key={`${v.parameterId ?? v.parameterName}`}
                            className={`inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded border ${readingTone(v)}`}
                            title={v.rule ?? undefined}
                          >
                            <span className="text-ink-secondary">{v.parameterName}:</span>
                            <span className="font-mono font-semibold">
                              {v.notApplicable ? `N/A${v.naReason ? ` (${v.naReason})` : ''}` : v.value ? `${readingText(v.value)}${v.unit ? ` ${v.unit}` : ''}` : '—'}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {c.exception && (
                      <div className="mt-1 text-exception">
                        <span className="font-semibold">Exception:</span> {[c.exception.reason, c.exception.remark].filter(Boolean).join(' — ')}
                        <span className="text-ink-muted">
                          {' '}
                          · {c.exception.status}
                          {c.exception.reviewedByName ? ` by ${c.exception.reviewedByName}` : ''}
                          {c.exception.resolutionNotes ? ` — ${c.exception.resolutionNotes}` : ''}
                        </span>
                      </div>
                    )}
                    {c.result === 'MISSED' && <div className="mt-1 text-missed">Missed: not submitted before {formatDateTime(c.windowEndsAt)}</div>}
                    {c.result === 'COMPLETED' && c.values.length === 0 && <span className="text-ink-faint">No readings on this check type</span>}
                    {!c.result && <span className="text-ink-faint">Not submitted yet</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )}
  </Card>
)
