import React from 'react'
import { AlertTriangle, ArrowLeft, Printer, RefreshCw } from 'lucide-react'
import type { CheckResult, QualityCheck } from '../../types'
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
                <Info label="Job No." value={check.jobNo} mono />
                <Info label="Device" value={check.deviceInfo} className="col-span-2 md:col-span-3" />
              </dl>
            </section>

            <section className="bg-white border border-line rounded-md shadow-2xs overflow-hidden printable-card">
              <SectionTitle
                title="Parameter values"
                subtitle="Values entered by the worker against the configured acceptance rules"
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
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {check.values.map((v, i) => (
                        <tr key={v.parameterId ?? i} className={v.result === 'FAIL' ? 'bg-missed-bg/40' : undefined}>
                          <td className="py-2 px-4 font-semibold text-ink">{v.parameterName}</td>
                          <td className="py-2 px-3 text-ink-muted">{PARAMETER_TYPE_LABEL[v.parameterType]}</td>
                          <td className="py-2 px-3 font-mono text-ink">
                            {v.value !== null && v.value !== '' ? (
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
                            {v.value !== null && v.value !== '' ? <StatusBadge status={v.result} size="sm" /> : <span className="text-ink-faint">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="printable-card">
              <EvidenceViewer media={check.media} workerName={check.submittedByName ?? check.workerName} deviceInfo={check.deviceInfo} />
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
