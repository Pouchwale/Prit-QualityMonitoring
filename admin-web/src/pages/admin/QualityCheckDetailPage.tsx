import React from 'react'
import { AlertTriangle, ArrowLeft, Printer, RefreshCw } from 'lucide-react'
import type { CheckResult, MediaFile, QualityCheck } from '../../types'
import { useApi } from '../../lib/useApi'
import { PARAMETER_TYPE_LABEL, formatDateTime, RESULT_LABEL } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { DataState } from '../../components/common/DataState'
import { CheckStatusBadge, StatusBadge } from '../../components/common/StatusBadge'
import { EvidenceViewer } from '../../components/common/EvidenceViewer'

interface QualityCheckDetailPageProps {
  checkId: string
  onBack: () => void
}

/** How the check was started. */
const SUBMISSION_LABEL = { MANUAL: 'Manual', NOTIFICATION: 'Notification' } as const

/**
 * Evidence grouped the way the worker captured it: one group per parameter (in form order),
 * then the overall check evidence (media with no parameter, including older checks).
 */
function evidenceGroups(check: QualityCheck): { key: string; label?: string; media: MediaFile[] }[] {
  const groups: { key: string; label?: string; media: MediaFile[] }[] = []
  for (const v of check.values) {
    if (!v.parameterId) continue
    const media = check.media.filter((m) => m.parameterId === v.parameterId)
    if (media.length > 0) groups.push({ key: v.parameterId, label: v.parameterName, media })
  }
  const overall = check.media.filter((m) => !m.parameterId)
  // Evidence of a parameter that is no longer on the form still belongs somewhere.
  const grouped = new Set(groups.map((g) => g.key))
  for (const m of check.media) {
    if (!m.parameterId || grouped.has(m.parameterId)) continue
    grouped.add(m.parameterId)
    groups.push({ key: m.parameterId, label: 'Removed parameter', media: check.media.filter((x) => x.parameterId === m.parameterId) })
  }
  if (overall.length > 0) groups.push({ key: 'overall', label: 'Overall evidence', media: overall })
  // Nothing at all: one empty viewer, with its usual "Live camera evidence" heading.
  if (groups.length === 0) groups.push({ key: 'overall', media: [] })
  return groups
}

/** Small outlined badge for the header and the parameter rows. */
const Chip: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone = 'border-line bg-subtle text-ink-secondary' }) => (
  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium whitespace-nowrap ${tone}`}>
    <span className="text-ink-muted">{label}</span>
    <span className="font-mono font-semibold">{value}</span>
  </span>
)

export const QualityCheckDetailPage: React.FC<QualityCheckDetailPageProps> = ({ checkId, onBack }) => {
  const { data: check, error, loading, reload } = useApi<QualityCheck>(`/api/quality-checks/${checkId}`)

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-line no-print">
        <div className="flex items-center gap-3 min-w-0">
          <Button size="sm" variant="outline" onClick={onBack} icon={<ArrowLeft className="w-3.5 h-3.5" />}>
            Back
          </Button>
          {check && (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold text-ink tracking-tight font-mono">{check.code}</h1>
                <CheckStatusBadge status={check.status} />
                {check.result && <ResultBadge result={check.result} />}
                {check.submissionType && <Chip label="Started" value={SUBMISSION_LABEL[check.submissionType]} />}
                {(check.itemCode || check.job?.itemCode) && <Chip label="Item Code" value={check.itemCode ?? check.job?.itemCode ?? ''} />}
                {(check.jobNo || check.job?.jobNo) && <Chip label="Job No." value={check.jobNo ?? check.job?.jobNo ?? ''} />}
                {check.nextDueAt && <Chip label="Next due" value={formatDateTime(check.nextDueAt)} />}
              </div>
              <p className="text-xs text-ink-muted mt-0.5">
                {check.machineName} · {check.activityName} · scheduled {formatDateTime(check.scheduledAt)}
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => reload()} loading={loading && check !== null} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()} disabled={!check} icon={<Printer className="w-3.5 h-3.5" />}>
            Print
          </Button>
        </div>
      </div>

      <DataState loading={loading} error={error} onRetry={reload} empty={check === null ? undefined : false}>
        {check && (
          <>
            {/* Print-only heading */}
            <div className="hidden print:block border-b border-ink pb-2">
              <h2 className="text-base font-bold uppercase">Quality Check Record</h2>
              <p className="text-xs font-mono">
                {check.code} · {check.status}
                {check.result ? ` · Result: ${RESULT_LABEL[check.result]}` : ''} · printed {formatDateTime(new Date().toISOString())}
              </p>
            </div>

            <section className="bg-white border border-line rounded-md shadow-2xs printable-card">
              <SectionTitle title="Check information" />
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 p-4 text-xs">
                <Info label="Machine" value={check.machineName} detail={check.machineCode} />
                <Info label="Department" value={check.departmentName} />
                <Info label="Check type" value={check.activityName} />
                <Info label="Shift" value={check.shiftName} />
                <Info label="Scheduled at" value={formatDateTime(check.scheduledAt)} mono />
                <Info label="Window ends" value={formatDateTime(check.windowEndsAt)} mono />
                <Info label="Assigned worker" value={check.workerName} detail={check.workerEmployeeId} />
                <Info
                  label="Submitted by"
                  value={check.submittedByName}
                  detail={[check.submittedByEmployeeId, check.submittedAt ? formatDateTime(check.submittedAt) : null].filter(Boolean).join(' · ') || null}
                />
                <Info label="Item Code" value={check.itemCode ?? check.job?.itemCode ?? null} mono />
                <Info label="Job No." value={check.jobNo ?? check.job?.jobNo ?? null} mono />
                <Info
                  label="Submission"
                  value={check.submissionType ? SUBMISSION_LABEL[check.submissionType] : null}
                  detail={check.submissionType === 'MANUAL' ? 'Started by the worker' : check.submissionType ? 'From a due notification' : null}
                />
                <Info label="Next check due" value={check.nextDueAt ? formatDateTime(check.nextDueAt) : null} mono />
                <Info label="Device" value={check.deviceInfo} className="col-span-2 md:col-span-4" />
              </dl>
            </section>

            <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden printable-card">
              <SectionTitle
                title="Parameter values"
                subtitle={`Values entered by the worker against the configured acceptance rules${
                  check.values.some((v) => v.notApplicable)
                    ? ` · ${check.values.filter((v) => v.notApplicable).length} not applicable (never counted as a failure)`
                    : ''
                }`}
                right={check.result ? <ResultBadge result={check.result} size="sm" /> : undefined}
              />
              {check.values.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-ink-muted">No parameter values were submitted for this check.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="stack-sm w-full text-left text-xs border-collapse">
                    <thead className="bg-slate-50 border-b border-line text-ink-secondary text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="py-2 px-4 font-semibold">Parameter</th>
                        <th className="py-2 px-3 font-semibold">Type</th>
                        <th className="py-2 px-3 font-semibold">Value</th>
                        <th className="py-2 px-3 font-semibold">Rule</th>
                        <th className="py-2 px-3 font-semibold">Reading</th>
                        <th className="py-2 px-3 font-semibold">Evidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {check.values.map((v, i) => {
                        const evidence = v.parameterId ? check.media.filter((m) => m.parameterId === v.parameterId) : []
                        return (
                          <tr key={v.parameterId ?? i} className={v.result === 'FAIL' ? 'bg-missed-bg/40' : undefined}>
                            <td className="py-2 px-4 font-semibold text-ink">{v.parameterName}</td>
                            <td className="py-2 px-3 text-ink-muted">{PARAMETER_TYPE_LABEL[v.parameterType]}</td>
                            <td className="py-2 px-3 font-mono text-ink">
                              {v.notApplicable ? (
                                <span className="font-sans text-ink-secondary">
                                  Not applicable — {v.naReason ?? 'no reason given'}
                                  {v.naRemark && <span className="block text-[11px] text-ink-muted">{v.naRemark}</span>}
                                </span>
                              ) : v.value !== null && v.value !== '' ? (
                                <>
                                  <span className="font-semibold">{v.value}</span>
                                  {v.unit && <span className="text-ink-muted ml-1">{v.unit}</span>}
                                </>
                              ) : (
                                <span className="text-ink-faint">—</span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-ink-secondary">{v.rule ?? '—'}</td>
                            <td className="py-2 px-3">
                              {v.notApplicable ? (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-line bg-slate-50 text-[11px] font-medium text-ink-muted">
                                  Not applicable
                                </span>
                              ) : v.value !== null && v.value !== '' ? (
                                <StatusBadge status={v.result} size="sm" />
                              ) : (
                                <span className="text-ink-faint">—</span>
                              )}
                            </td>
                            <td className="py-2 px-3">
                              {evidence.length > 0 ? <EvidenceViewer media={evidence} compact /> : <span className="text-ink-faint">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* One block per parameter that has evidence, then the overall check evidence. */}
            <section className="printable-card space-y-3">
              {evidenceGroups(check).map((group) => (
                <EvidenceViewer
                  key={group.key}
                  label={group.label}
                  media={group.media}
                  workerName={check.submittedByName ?? check.workerName}
                  deviceInfo={check.deviceInfo}
                />
              ))}
            </section>

            {check.exception && (
              <section className="bg-white border border-exception-line rounded-md shadow-2xs overflow-hidden printable-card">
                <div className="px-4 py-2.5 border-b border-exception-line bg-exception-bg flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-exception">
                    <AlertTriangle className="w-4 h-4" />
                    Exception raised
                  </div>
                  <StatusBadge status={check.exception.status} size="sm" />
                </div>
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 p-4 text-xs">
                  <Info label="Reason" value={check.exception.reason} className="col-span-2" />
                  <Info label="Raised at" value={formatDateTime(check.exception.createdAt)} mono />
                  <Info label="Reviewed by" value={check.exception.reviewedByName} />
                  <Info label="Worker remark" value={check.exception.remark} className="col-span-2" multiline />
                  <Info label="Resolution notes" value={check.exception.resolutionNotes} className="col-span-2" multiline />
                </dl>
                <div className="px-4 pb-4">
                  <div className="text-[11px] font-semibold text-ink-secondary mb-1.5">Exception photo</div>
                  <EvidenceViewer media={check.exception.media} workerName={check.submittedByName ?? check.workerName} />
                </div>
              </section>
            )}
          </>
        )}
      </DataState>
    </div>
  )
}

const SectionTitle: React.FC<{ title: string; subtitle?: string; right?: React.ReactNode }> = ({ title, subtitle, right }) => (
  <div className="px-4 py-2.5 border-b border-line bg-slate-50 flex items-center justify-between gap-3">
    <div>
      <h2 className="text-sm font-bold text-ink tracking-tight">{title}</h2>
      {subtitle && <p className="text-[11px] text-ink-muted">{subtitle}</p>}
    </div>
    {right}
  </div>
)

const Info: React.FC<{
  label: string
  value: string | null | undefined
  detail?: string | null
  mono?: boolean
  multiline?: boolean
  className?: string
}> = ({ label, value, detail, mono, multiline, className = '' }) => (
  <div className={`min-w-0 ${className}`}>
    <dt className="text-[11px] text-ink-muted">{label}</dt>
    <dd className={`mt-0.5 font-medium ${value ? 'text-ink' : 'text-ink-faint'} ${mono ? 'font-mono' : ''} ${multiline ? 'whitespace-pre-wrap' : 'truncate'}`} title={multiline ? undefined : (value ?? undefined)}>
      {value || '—'}
    </dd>
    {detail && <dd className="text-[11px] text-ink-muted font-mono truncate">{detail}</dd>}
  </div>
)

/** Overall result: Completed, Missed or Exception. */
const ResultBadge: React.FC<{ result: CheckResult; size?: 'sm' | 'md' }> = ({ result, size = 'md' }) => (
  <span className="inline-flex items-center gap-1">
    <span className="text-[11px] text-ink-muted">Result</span>
    <StatusBadge status={result} size={size} showDot={false} />
  </span>
)
