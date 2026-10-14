import React from 'react'
import { ClipboardList, FileSearch, History, Package, Truck, Users } from 'lucide-react'
import type { QualityCheck, TraceChange, TraceGroup, TraceReport, TraceWorker } from '../../../types'
import { formatDateTime } from '../../../lib/format'
import { StatusBadge } from '../../../components/common/StatusBadge'
import { Card, CardHeader, EmptyState } from '../../../components/ui/Card'
import { itemCodeOf, jobNoOf, readingText } from './checkFields'

const doerOf = (c: QualityCheck) => ({
  name: c.submittedByName ?? c.workerName ?? 'Unassigned',
  employeeId: c.submittedByEmployeeId ?? c.workerEmployeeId
})

const NONE = <span className="text-ink-faint">None</span>
const list = (values: string[]) => (values.filter(Boolean).length ? values.filter(Boolean).join(', ') : NONE)

/** A report section: card with icon, title, the explanation behind an info tip and a count. */
const Section: React.FC<{ title: string; icon: React.ReactNode; subtitle?: string; note?: string; count?: number; children: React.ReactNode }> = ({
  title,
  icon,
  subtitle,
  note,
  count,
  children
}) => (
  <Card className="overflow-hidden printable-card">
    <CardHeader
      icon={icon}
      title={title}
      subtitle={subtitle}
      info={note}
      actions={
        count !== undefined ? (
          <span className="h-5 min-w-5 px-1.5 inline-flex items-center justify-center rounded-full bg-subtle text-ink-secondary ring-1 ring-inset ring-line text-[11px] font-semibold tabular-nums">
            {count}
          </span>
        ) : undefined
      }
    />
    {children}
  </Card>
)

const Num: React.FC<{ value: number; tone?: string }> = ({ value, tone = 'text-ink' }) => (
  <td className={`num ${value > 0 ? `${tone} font-semibold` : 'text-ink-faint'}`}>{value}</td>
)

/** Long tables scroll inside their card on screen (sticky header) and print in full. */
const scroller = 'overflow-x-auto lg:max-h-[520px] lg:overflow-y-auto print:max-h-none print:overflow-visible'


/** Headline numbers of the traced records. */
export const TraceSummary: React.FC<{ trace: TraceReport; scope: string }> = ({ trace, scope }) => {
  const c = trace.counts
  const tiles: { label: string; value: number | string; tone?: string }[] = [
    { label: 'Times checked', value: c.checks },
    { label: 'Completed', value: c.completed, tone: 'text-success' },
    { label: 'Missed', value: c.missed, tone: 'text-missed' },
    { label: 'Exceptions', value: c.exceptions, tone: 'text-exception' },
    { label: 'Readings', value: c.readings },
    { label: 'Outside limits', value: c.outsideLimits, tone: 'text-missed' },
    { label: 'Changes', value: c.changes },
    { label: 'Corrections', value: c.corrections, tone: 'text-success' },
    { label: 'Item Codes', value: trace.items.filter((i) => i.key).length },
    { label: 'PO Nos.', value: trace.jobs.filter((j) => j.key).length }
  ]
  return (
    <Section
      icon={<FileSearch className="w-4 h-4" />}
      title={`Traceability: ${scope}`}
      subtitle="Checks, readings, changes and exceptions of this selection"
      note="Every check, reading, change and exception for the selected Item Code, PO No. and worker in this period."
    >
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-line">
        {tiles.map((t) => (
          <div key={t.label} className="bg-surface px-4 py-2.5">
            <div className="text-[12px] font-medium text-ink-secondary">{t.label}</div>
            <div className={`mt-0.5 text-[20px] leading-tight font-semibold tabular-nums ${t.value ? (t.tone ?? 'text-ink') : 'text-ink-faint'}`}>{t.value}</div>
          </div>
        ))}
      </div>
    </Section>
  )
}

/** Per Item Code (with its PO Nos.) or per PO No. (with its Item Codes). */
export const TraceGroupTable: React.FC<{ kind: 'item' | 'job'; rows: TraceGroup[]; onPick?: (value: string) => void }> = ({ kind, rows, onPick }) => {
  const isItem = kind === 'item'
  return (
    <Section
      icon={isItem ? <Package className="w-4 h-4" /> : <Truck className="w-4 h-4" />}
      title={isItem ? 'Item Codes' : 'PO Nos.'}
      subtitle={isItem ? 'Checks per item, with its jobs, workers and machines' : 'Checks per job, with its items, workers and machines'}
      note={isItem ? 'How many times each item was checked, on which jobs, by whom and on which machines.' : 'Each job with its item codes, checks, workers and machines.'}
      count={rows.length}
    >
      {rows.length === 0 ? (
        <EmptyState title="No records." compact />
      ) : (
        <div className={scroller}>
          <table className="data-table pin-first">
            <thead>
              <tr>
                <th>{isItem ? 'Item Code' : 'PO No.'}</th>
                <th>{isItem ? 'PO Nos.' : 'Item Codes'}</th>
                <th className="num">Checks</th>
                <th className="num">Completed</th>
                <th className="num">Missed</th>
                <th className="num">Exception</th>
                <th className="num">Readings</th>
                <th className="num">Outside limits</th>
                <th className="num">Changes</th>
                <th className="num">Corrections</th>
                <th>Workers</th>
                <th>Machines</th>
                <th>First / last check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key || '—'}>
                  <td className="whitespace-nowrap font-mono font-semibold">
                    {r.key && onPick ? (
                      <button type="button" className="text-accent hover:underline" title={`Show only ${r.key}`} onClick={() => onPick(r.key)}>
                        {r.key}
                      </button>
                    ) : (
                      r.key || NONE
                    )}
                  </td>
                  <td className="font-mono text-ink-secondary">{list(isItem ? r.jobNos : r.itemCodes)}</td>
                  <Num value={r.checks} />
                  <Num value={r.completed} tone="text-success" />
                  <Num value={r.missed} tone="text-missed" />
                  <Num value={r.exceptions} tone="text-exception" />
                  <Num value={r.readings} />
                  <Num value={r.outsideLimits} tone="text-missed" />
                  <Num value={r.changes} />
                  <Num value={r.corrections} tone="text-success" />
                  <td>{list(r.workers)}</td>
                  <td className="text-ink-secondary">{list(r.machines)}</td>
                  <td className="whitespace-nowrap tabular-nums text-ink-secondary">
                    {formatDateTime(r.firstAt)}
                    <div className="text-[11.5px] text-ink-muted">{formatDateTime(r.lastAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

/** Small "label value" figure for a worker's summary line. */
const Figure: React.FC<{ label: string; value: number; tone?: string }> = ({ label, value, tone = 'text-ink' }) => (
  <span className="whitespace-nowrap">
    <span className={`font-semibold tabular-nums ${value > 0 ? tone : 'text-ink-faint'}`}>{value}</span> <span className="text-ink-muted">{label}</span>
  </span>
)

/** Each worker with every Item Code they checked, its PO Nos. and number of checks. */
export const TraceWorkers: React.FC<{ workers: TraceWorker[]; onPickItem?: (value: string) => void }> = ({ workers, onPickItem }) => (
  <Section
    icon={<Users className="w-4 h-4" />}
    title="Worker activity by Item Code"
    subtitle="Items each worker checked, with jobs and results"
    note="Checks are counted for the worker who submitted them, or the worker they were assigned to."
    count={workers.length}
  >
    {workers.length === 0 ? (
      <EmptyState title="No records." compact />
    ) : (
      <div className="divide-y divide-line">
        {workers.map((w) => (
          <div key={w.workerId ?? w.name} className="py-3">
            <div className="px-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px]">
              <span className="font-semibold text-ink">{w.name}</span>
              {w.employeeId && <span className="font-mono text-[11.5px] text-ink-muted">{w.employeeId}</span>}
              <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
                <Figure label="checks" value={w.checks} />
                <Figure label="completed" value={w.completed} tone="text-success" />
                <Figure label="missed" value={w.missed} tone="text-missed" />
                <Figure label="exception" value={w.exceptions} tone="text-exception" />
                <span className="whitespace-nowrap">
                  <Figure label="changes" value={w.changes} /> <span className="text-ink-muted">({w.corrections} corrections)</span>
                </span>
              </span>
              <span className="text-[12px] text-ink-muted">Machines: {list(w.machines)}</span>
            </div>
            <div className="overflow-x-auto mt-2">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item Code</th>
                    <th>PO Nos.</th>
                    <th className="num">Checks</th>
                    <th className="num">Completed</th>
                    <th className="num">Missed</th>
                    <th className="num">Exception</th>
                    <th className="num">Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {w.items.map((i) => (
                    <tr key={i.itemCode || '—'}>
                      <td className="font-mono font-semibold whitespace-nowrap">
                        {i.itemCode && onPickItem ? (
                          <button type="button" className="text-accent hover:underline" title={`Show only ${i.itemCode}`} onClick={() => onPickItem(i.itemCode)}>
                            {i.itemCode}
                          </button>
                        ) : (
                          i.itemCode || NONE
                        )}
                      </td>
                      <td className="font-mono text-ink-secondary">{list(i.jobNos)}</td>
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
  </Section>
)

const pill = 'inline-flex items-center h-5 px-2 rounded-full ring-1 ring-inset text-[11px] font-medium whitespace-nowrap'
const changeType = (ch: TraceChange) =>
  ch.correction ? (
    <span className={`${pill} bg-success-bg text-success ring-success-line`}>Correction</span>
  ) : ch.wentOutside ? (
    <span className={`${pill} bg-missed-bg text-missed ring-missed-line`}>Went outside limits</span>
  ) : (
    <span className={`${pill} bg-subtle text-ink-secondary ring-line`}>Change</span>
  )

/** Every reading that changed from the previous reading of the same parameter. */
export const TraceChanges: React.FC<{ changes: TraceChange[] }> = ({ changes }) => (
  <Section
    icon={<History className="w-4 h-4" />}
    title="Changes and corrections"
    subtitle="Readings that differ from the previous reading"
    note="A change is a reading that differs from the previous reading of the same parameter for the same item, job and machine. A correction is a change from outside limits back within limits."
    count={changes.length}
  >
    {changes.length === 0 ? (
      <EmptyState icon={<History className="w-5 h-5" />} title="No reading changed in this period." compact />
    ) : (
      <div className={scroller}>
        <table className="data-table stack-sm">
          <thead>
            <tr>
              <th>Date / time</th>
              <th>Parameter</th>
              <th>From → To</th>
              <th>Type</th>
              <th>Machine</th>
              <th>Item / PO</th>
              <th>Changed by</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((ch, i) => (
              <tr key={`${ch.checkId}-${ch.parameterName}-${i}`}>
                <td className="whitespace-nowrap tabular-nums">{formatDateTime(ch.at)}</td>
                <td className="font-medium text-ink">{ch.parameterName}</td>
                <td className="whitespace-nowrap">
                  <span className="font-mono">
                    {readingText(ch.from)}
                    {ch.unit ? ` ${ch.unit}` : ''} → <span className="font-semibold">{readingText(ch.to)}</span>
                    {ch.unit ? ` ${ch.unit}` : ''}
                  </span>
                  <div className="text-[11.5px] text-ink-muted">
                    {ch.fromResult} → {ch.toResult}
                  </div>
                </td>
                <td className="whitespace-nowrap">{changeType(ch)}</td>
                <td className="whitespace-nowrap">{ch.machineName}</td>
                <td className="whitespace-nowrap font-mono">
                  <div>{ch.itemCode || NONE}</div>
                  <div className="text-[11.5px] text-ink-muted">{ch.jobNo || NONE}</div>
                </td>
                <td className="whitespace-nowrap">
                  {ch.byName}
                  {ch.byEmployeeId && <span className="text-[11.5px] text-ink-muted font-mono"> · {ch.byEmployeeId}</span>}
                  <div className="text-[11.5px] text-ink-muted">
                    Previous: {ch.previousByName}, {formatDateTime(ch.previousAt)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Section>
)

const readingTone = (v: QualityCheck['values'][number]) =>
  v.notApplicable ? 'bg-subtle text-ink-muted ring-line' : v.result === 'FAIL' ? 'bg-missed-bg text-missed ring-missed-line' : 'bg-surface text-ink ring-line'

/** Every check in full: when, where, item and job, who, result, every reading and the exception. */
export const DetailedRecords: React.FC<{ checks: QualityCheck[]; onViewCheck?: (id: string) => void }> = ({ checks, onViewCheck }) => (
  <Section
    icon={<ClipboardList className="w-4 h-4" />}
    title="Detailed records"
    subtitle="Every check with its readings and remarks"
    note="Every check with all its parameter readings, who did it and any exception."
    count={checks.length}
  >
    {checks.length === 0 ? (
      <EmptyState title="No records." compact />
    ) : (
      <div className="overflow-x-auto lg:max-h-[720px] lg:overflow-y-auto print:max-h-none print:overflow-visible">
        <table className="data-table stack-sm">
          <thead>
            <tr>
              <th>Date / time</th>
              <th>Machine</th>
              <th>Item / PO</th>
              <th>Check type</th>
              <th>Worker</th>
              <th>Result</th>
              <th>Readings and remarks</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const doer = doerOf(c)
              return (
                <tr key={c.id} className="[&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums">
                    {formatDateTime(c.submittedAt ?? c.scheduledAt)}
                    <div className="text-[11.5px] text-ink-muted font-mono">
                      {onViewCheck ? (
                        <button type="button" className="hover:underline hover:text-accent" onClick={() => onViewCheck(c.id)}>
                          {c.code}
                        </button>
                      ) : (
                        c.code
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">
                    {c.machineName}
                    <div className="text-[11.5px] text-ink-muted font-mono">{c.machineCode}</div>
                  </td>
                  <td className="whitespace-nowrap font-mono">
                    <div>{itemCodeOf(c) || NONE}</div>
                    <div className="text-[11.5px] text-ink-muted">{jobNoOf(c) || NONE}</div>
                  </td>
                  <td className="text-ink-secondary">
                    {c.activityName}
                    <div className="text-[11.5px] text-ink-muted">{c.shiftName ?? ''}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    {doer.name}
                    {doer.employeeId && <div className="text-[11.5px] text-ink-muted font-mono">{doer.employeeId}</div>}
                  </td>
                  <td className="whitespace-nowrap">
                    {c.result ? (
                      <StatusBadge status={c.result} size="sm" />
                    ) : (
                      <span className="inline-flex items-center h-5 px-1.5 rounded-full ring-1 ring-inset ring-line-strong bg-surface text-ink-muted text-[11px] font-medium">Open</span>
                    )}
                    {c.submissionType && <div className="text-[11.5px] text-ink-muted mt-0.5">{c.submissionType === 'MANUAL' ? 'Manual' : 'Notification'}</div>}
                  </td>
                  <td className="min-w-[240px]">
                    {c.values.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {c.values.map((v) => (
                          <span
                            key={`${v.parameterId ?? v.parameterName}`}
                            className={`inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded-md ring-1 ring-inset text-[11.5px] ${readingTone(v)}`}
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
                      <div className="mt-1 text-[12px] text-exception">
                        <span className="font-semibold">Exception:</span> {[c.exception.reason, c.exception.reading, c.exception.remark].filter(Boolean).join(' — ')}
                        <span className="text-ink-muted">
                          {' '}
                          · {c.exception.status}
                          {c.exception.reviewedByName ? ` by ${c.exception.reviewedByName}` : ''}
                          {c.exception.resolutionNotes ? ` — ${c.exception.resolutionNotes}` : ''}
                        </span>
                      </div>
                    )}
                    {c.result === 'MISSED' && <div className="mt-1 text-[12px] text-missed">Missed: not submitted before {formatDateTime(c.windowEndsAt)}</div>}
                    {c.result === 'COMPLETED' && c.values.length === 0 && <span className="text-ink-muted">No readings on this check type</span>}
                    {!c.result && <span className="text-ink-muted">Not submitted yet</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )}
  </Section>
)
